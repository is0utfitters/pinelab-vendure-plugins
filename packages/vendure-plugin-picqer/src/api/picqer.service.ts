import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import {
  UpdateProductInput,
  UpdateProductVariantInput,
} from '@vendure/common/lib/generated-types';
import {
  Address,
  AssetService,
  ChannelService,
  ConfigService,
  Customer,
  EntityHydrator,
  EventBus,
  ForbiddenError,
  Fulfillment,
  ID,
  JobQueue,
  JobQueueService,
  Logger,
  Order,
  OrderPlacedEvent,
  OrderService,
  ProductEvent,
  ProductService,
  ProductVariant,
  ProductVariantEvent,
  ProductVariantService,
  RequestContext,
  SerializedRequestContext,
  StockMovementEvent,
  TransactionalConnection,
  assertFound,
} from '@vendure/core';
import { StockAdjustment } from '@vendure/core/dist/entity/stock-movement/stock-adjustment.entity';
import currency from 'currency.js';
import { PLUGIN_INIT_OPTIONS, loggerCtx } from '../constants';
import { PicqerOptions } from '../picqer.plugin';
import {
  PicqerConfig,
  PicqerConfigInput,
  TestPicqerInput,
} from '../ui/generated/graphql';
import { PicqerConfigEntity } from './picqer-config.entity';
import { PicqerClient, PicqerClientInput } from './picqer.client';
import {
  AddressInput,
  CustomerData,
  CustomerInput,
  IncomingWebhook,
  OrderInput,
  OrderProductInput,
  PickListWebhookData,
  ProductData,
  ProductInput,
  WebhookInput,
} from './types';
import { OrderLineInput } from '@vendure/common/lib/generated-types';
import { picqerHandler } from './picqer.handler';
import { throwIfTransitionFailed } from '../../../util/src';

/**
 * Job to push variants from Vendure to Picqer
 */
interface PushVariantsJob {
  action: 'push-variants';
  ctx: SerializedRequestContext;
  variantIds?: ID[];
  productId?: ID;
}

/**
 * Job to pull stock levels from Picqer into Vendure
 */
interface PullStockLevelsJob {
  action: 'pull-stock-levels';
  ctx: SerializedRequestContext;
  variantIds?: ID[];
  productId?: ID;
}

/**
 * Job to push orders to Picqer
 */
interface PushOrderJob {
  action: 'push-order';
  ctx: SerializedRequestContext;
  orderId: ID;
}

type JobData = PushVariantsJob | PullStockLevelsJob | PushOrderJob;

@Injectable()
export class PicqerService implements OnApplicationBootstrap {
  private jobQueue!: JobQueue<JobData>;

  constructor(
    @Inject(PLUGIN_INIT_OPTIONS) private options: PicqerOptions,
    private eventBus: EventBus,
    private jobQueueService: JobQueueService,
    private connection: TransactionalConnection,
    private variantService: ProductVariantService,
    private productService: ProductService,
    private assetService: AssetService,
    private configService: ConfigService,
    private entityHydrator: EntityHydrator,
    private channelService: ChannelService,
    private orderService: OrderService
  ) {}

  async onApplicationBootstrap() {
    // Create JobQueue and handlers
    this.jobQueue = await this.jobQueueService.createQueue({
      name: 'picqer-sync',
      process: async ({ data }) => {
        const ctx = RequestContext.deserialize(data.ctx);
        try {
          if (data.action === 'push-variants') {
            await this.handlePushVariantsJob(
              ctx,
              data.variantIds,
              data.productId
            );
          } else if (data.action === 'pull-stock-levels') {
            await this.handlePullStockLevelsJob(ctx);
          } else if (data.action === 'push-order') {
            await this.handlePushOrderJob(ctx, data.orderId);
          } else {
            Logger.error(
              `Invalid job action: ${(data as any).action}`,
              loggerCtx
            );
          }
        } catch (e: unknown) {
          if (e instanceof Error) {
            // Only log a warning, because this is a background function that will be retried by the JobQueue
            Logger.warn(
              `Failed to handle job '${data.action}': ${e?.message}`,
              loggerCtx
            );
          }
          throw e;
        }
      },
    });
    // Listen for Variant creation or update
    this.eventBus
      .ofType(ProductVariantEvent)
      .subscribe(async ({ ctx, entity: entities, type, input }) => {
        if (type !== 'created' && type !== 'updated') {
          // Ignore anything other than creation or update
          return;
        }
        // Only update in Picqer if one of these fields was updated
        const shouldUpdate = (input as UpdateProductVariantInput[])?.some(
          (v) => v.enabled ?? v.translations ?? v.price ?? v.taxCategoryId
        );
        if (!shouldUpdate) {
          Logger.info(
            `No relevant changes to variants ${entities.map(
              (v) => v.sku
            )}, not pushing to Picqer`,
            loggerCtx
          );
          return;
        }
        await this.addPushVariantsJob(
          ctx,
          entities.map((v) => v.id)
        );
      });
    // Listen for Product events. Only push variants when product is enabled/disabled. Other changes are handled by the variant events.
    this.eventBus
      .ofType(ProductEvent)
      .subscribe(async ({ ctx, entity, type, input }) => {
        // Only push if `enabled` is updated
        if (
          type === 'updated' &&
          (input as UpdateProductInput).enabled !== undefined
        ) {
          await this.addPushVariantsJob(ctx, undefined, entity.id);
        }
      });
    // Listen for Order placed events
    this.eventBus.ofType(OrderPlacedEvent).subscribe(async ({ ctx, order }) => {
      await this.addPushOrderJob(ctx, order);
    });
  }

  /**
   * Checks if webhooks for events exist in Picqer, if not, register new webhooks.
   * When hooks exist, but url or secret is different, it will create new hooks.
   *
   * Registers hooks for: products.free_stock_changed and orders.completed
   */
  async registerWebhooks(
    ctx: RequestContext,
    config: PicqerConfig
  ): Promise<void> {
    const hookUrl = `${this.options.vendureHost}/picqer/hooks/${ctx.channel.token}`;
    const client = await this.getClient(ctx, config);
    if (!client) {
      return;
    }
    const eventsToRegister: WebhookInput['event'][] = [
      'products.free_stock_changed',
      'picklists.closed',
    ];
    for (const hookEvent of eventsToRegister) {
      // Use first 4 digits of webhook secret as name, so we can identify the hook
      const webhookName = `Vendure ${hookEvent} ${client.webhookSecret.slice(
        0,
        4
      )}`;
      const webhooks = await client.getWebhooks();
      let hook = webhooks.find(
        (h) =>
          h.event === hookEvent && h.address === hookUrl && h.active === true
      );
      if (hook && hook.name !== webhookName) {
        // A hook exists, but the name is different, that means the secret changed. We need to create a new hook
        // The combination of hook address and hook event must be unique in picqer
        Logger.info(`Deactivating outdated hook ${hook.name}`);
        await client.deactivateHook(hook.idhook);
        hook = undefined; // Set as undefined, because we deactivated the previous one
      }
      if (!hook) {
        const webhook = await client.createWebhook({
          name: webhookName,
          address: hookUrl,
          event: hookEvent,
          secret: client.webhookSecret,
        });
        Logger.info(
          `Registered hook (id: ${webhook.idhook}) for event ${hookEvent} and url ${hookUrl}`,
          loggerCtx
        );
      }
    }
    Logger.info(
      `Registered webhooks for channel ${ctx.channel.token}`,
      loggerCtx
    );
  }

  /**
   * Handle incoming webhooks
   */
  async handleHook(input: {
    channelToken: string;
    body: IncomingWebhook;
    rawBody: string;
    signature: string;
  }): Promise<void> {
    // Get client for channelToken
    const ctx = await this.getCtxForChannel(input.channelToken);
    const client = await this.getClient(ctx);
    if (!client) {
      Logger.error(
        `No client found for channel ${input.channelToken}`,
        loggerCtx
      );
      return;
    }
    // Verify signature
    if (!client.isSignatureValid(input.rawBody, input.signature)) {
      Logger.error(
        `Invalid signature for incoming webhook ${input.body.event} channel ${input.channelToken}`,
        loggerCtx
      );
      throw new ForbiddenError();
    }
    if (input.body.event === 'products.free_stock_changed') {
      await this.updateStockBySkus(ctx, [input.body.data]);
    } else if (input.body.event === 'picklists.closed') {
      await this.handlePicklistClosed(ctx, input.body.data);
    } else {
      Logger.warn(
        `Unknown event ${
          (input.body as any).event
        } for incoming webhook for channel ${
          input.channelToken
        }. Not handling this webhook...`,
        loggerCtx
      );
      return;
    }
    Logger.info(`Successfully handled hook ${input.body.event}`, loggerCtx);
  }

  async triggerFullSync(ctx: RequestContext): Promise<boolean> {
    const variantIds: ID[] = [];
    let skip = 0;
    const take = 1000;
    let hasMore = true;
    while (hasMore) {
      // Only fetch IDs, not the whole entities
      const [variants, count] = await this.connection
        .getRepository(ctx, ProductVariant)
        .createQueryBuilder('variant')
        .select(['variant.id'])
        .leftJoin('variant.channels', 'channel')
        .leftJoin('variant.product', 'product')
        .where('channel.id = :channelId', { channelId: ctx.channelId })
        .andWhere('variant.deletedAt IS NULL')
        .andWhere('variant.enabled = true')
        .andWhere('product.deletedAt IS NULL')
        .andWhere('product.enabled is true')
        .skip(skip)
        .take(take)
        .getManyAndCount();
      variantIds.push(...variants.map((v) => v.id));
      if (variantIds.length >= count) {
        hasMore = false;
      }
      skip += take;
    }
    // Create batches
    const batchSize = 10;
    while (variantIds.length) {
      await this.addPushVariantsJob(ctx, variantIds.splice(0, batchSize));
    }
    await this.jobQueue.add(
      {
        action: 'pull-stock-levels',
        ctx: ctx.serialize(),
      },
      { retries: 10 }
    );
    Logger.info(`Added 'pull-stock-levels' job to queue`, loggerCtx);
    return true;
  }

  /**
   * When a picklist is closed, a fulfillment for the picked variants is created
   * This results in a PartiallyShipped or Shipped order state
   */
  async handlePicklistClosed(ctx: RequestContext, data: PickListWebhookData) {
    const order = await this.orderService.findOneByCode(ctx, data.reference, [
      'lines',
      'lines.productVariant',
    ]);
    if (!order) {
      throw new Error(`No order found for code ${data.reference}`);
    }
    const orderLinesToFulfill: OrderLineInput[] = [];

    data.products.forEach((pickListProduct) => {
      if (!pickListProduct.amountpicked) {
        Logger.warn(
          `Incoming webhook has no "amountpicked" set for product ${pickListProduct.productcode}, not fulfilling this product`,
          loggerCtx
        );
        return;
      }
      const orderLine = order.lines.find(
        (l) => l.productVariant.sku === pickListProduct.productcode
      );
      if (orderLine) {
        orderLinesToFulfill.push({
          orderLineId: orderLine.id,
          quantity: pickListProduct.amountpicked,
        });
      } else {
        Logger.error(
          `Trying to fulfill order ${order.code}, but no variant was found with SKU ${pickListProduct.productcode}`,
          loggerCtx
        );
      }
    });
    const fulfillmentResult = await this.orderService.createFulfillment(ctx, {
      handler: {
        code: picqerHandler.code,
        arguments: [],
      },
      lines: orderLinesToFulfill,
    });
    throwIfTransitionFailed(fulfillmentResult);
    let updatedOrder = await assertFound(
      this.orderService.findOne(ctx, order.id, [])
    );
    Logger.info(
      `Fulfilled order ${updatedOrder.code}. Order is now "${updatedOrder.state}"`,
      loggerCtx
    );
    // Transition to Shipped
    const fulfillment = fulfillmentResult as Fulfillment; // This is safe, because we checked for errors
    const transitionToShippedResult =
      await this.orderService.transitionFulfillmentToState(
        ctx,
        fulfillment.id,
        'Shipped'
      );
    throwIfTransitionFailed(transitionToShippedResult);
    updatedOrder = await assertFound(
      this.orderService.findOne(ctx, order.id, [])
    );
    Logger.info(
      `Marked fulfilment ${fulfillment.id} for order ${updatedOrder.code} as "Shipped". Order is now "${updatedOrder.state}"`,
      loggerCtx
    );
    // Transition to Delivered.
    // We automatically mark fulfillment as Delivered, because we don't have a way to track delivery in Picqer yet
    const transitionToDeliveredResult =
      await this.orderService.transitionFulfillmentToState(
        ctx,
        fulfillment.id,
        'Delivered'
      );
    throwIfTransitionFailed(transitionToDeliveredResult);
    updatedOrder = await assertFound(
      this.orderService.findOne(ctx, order.id, [])
    );
    Logger.info(
      `Marked fulfilment ${fulfillment.id} for order ${updatedOrder.code} as "Delivered". Order is now "${updatedOrder.state}"`,
      loggerCtx
    );
  }

  /**
   * Add a job to the queue to push variants to Picqer
   */
  async addPushVariantsJob(
    ctx: RequestContext,
    variantIds?: ID[],
    productId?: ID
  ): Promise<void> {
    await this.jobQueue.add(
      {
        action: 'push-variants',
        ctx: ctx.serialize(),
        variantIds,
        productId,
      },
      { retries: 10 }
    );
    if (variantIds) {
      Logger.info(
        `Added job to the 'push-variants' queue for ${variantIds.length} variants for channel ${ctx.channel.token}`,
        loggerCtx
      );
    } else {
      Logger.info(
        `Added job to the 'push-variants' queue for product ${productId} and channel ${ctx.channel.token}`,
        loggerCtx
      );
    }
  }

  /**
   * Add a job to the queue to push orders to Picqer
   */
  async addPushOrderJob(ctx: RequestContext, order: Order): Promise<void> {
    await this.jobQueue.add(
      {
        action: 'push-order',
        ctx: ctx.serialize(),
        orderId: order.id,
      },
      { retries: 10 }
    );
    Logger.info(
      `Added job to the 'push-order' queue for order ${order.code}`,
      loggerCtx
    );
  }

  /**
   * Pulls all products from Picqer and updates the stock levels in Vendure
   * based on the stock levels from Picqer products
   */
  async handlePullStockLevelsJob(userCtx: RequestContext): Promise<void> {
    const ctx = this.createDefaultLanguageContext(userCtx);
    const client = await this.getClient(ctx);
    if (!client) {
      return;
    }
    const picqerProducts = await client.getAllActiveProducts();
    await this.updateStockBySkus(ctx, picqerProducts);
    Logger.info(`Successfully pulled stock levels from Picqer`, loggerCtx);
  }

  /**
   * Update variant stocks in Vendure based on given Picqer products
   */
  async updateStockBySkus(
    ctx: RequestContext,
    picqerProducts: ProductData[]
  ): Promise<void> {
    const vendureVariants = await this.findAllVariantsBySku(
      ctx,
      picqerProducts.map((p) => p.productcode)
    );
    const stockAdjustments: StockAdjustment[] = [];
    let updateCount = 0; // Nr of variants that were updated
    // Loop over variants to determine new stock level per variant and update in DB
    await Promise.all(
      vendureVariants.map(async (variant) => {
        const picqerProduct = picqerProducts.find(
          (p) => p.productcode === variant.sku
        );
        if (!picqerProduct) {
          return; // Should never happen
        }
        const picqerStockLevel = picqerProduct?.stock?.[0]?.freestock;
        if (!picqerStockLevel) {
          Logger.info(
            `Picqer product ${picqerProduct.idproduct} (sku ${picqerProduct.productcode}) has no stock set, not updating variant in Vendure`,
            loggerCtx
          );
        }
        const newStockOnHand = variant.stockAllocated + (picqerStockLevel || 0);
        // Fields from picqer that should be added to the variant
        let additionalVariantFields = {};
        try {
          additionalVariantFields =
            this.options.pullPicqerProductFields?.(picqerProduct) || {};
        } catch (e: any) {
          Logger.error(
            `Failed to get additional fields from the configured pullFieldsFromPicqer function: ${e?.message}`,
            loggerCtx
          );
        }
        // Update the actual variant in Vendure, with raw connection for better performance
        await this.connection.getRepository(ctx, ProductVariant).update(
          { id: variant.id },
          {
            ...additionalVariantFields,
            stockOnHand: newStockOnHand,
          }
        );
        // Add stock adjustment
        stockAdjustments.push(
          new StockAdjustment({
            quantity: newStockOnHand - variant.stockOnHand, // Delta
            productVariant: { id: variant.id },
          })
        );
        updateCount++;
      })
    );
    await this.eventBus.publish(new StockMovementEvent(ctx, stockAdjustments));
    Logger.info(`Updated stock levels of ${updateCount} variants`, loggerCtx);
  }

  /**
   * Fetch order with relations and push it as order to Picqer
   */
  async handlePushOrderJob(ctx: RequestContext, orderId: ID): Promise<void> {
    const client = await this.getClient(ctx);
    if (!client) {
      // This means Picqer is not configured, so ignore this job
      return;
    }
    const order = await this.orderService.findOne(ctx, orderId, [
      'lines',
      'lines.productVariant',
      'lines.productVariant.taxCategory',
      'customer',
      'customer.addresses',
      'shippingLines',
      'shippingLines.shippingMethod',
    ]);
    if (!order) {
      Logger.error(
        `Order with id ${orderId} not found, ignoring this order...`,
        loggerCtx
      );
      return;
    }
    const hasPicqerHandler = order.shippingLines.some(
      (s) => s.shippingMethod?.fulfillmentHandlerCode === picqerHandler.code
    );
    if (!hasPicqerHandler) {
      Logger.info(
        `Order ${order.code} doesn't have the Picqer handler set in shipping lines, ignoring this order...`,
        loggerCtx
      );
      return;
    }
    Logger.info(`Pushing order ${order.code} to Picqer...`, loggerCtx);
    if (!order.customer) {
      Logger.error(
        `Order ${order.code} doesn't have a customer. So, something is wrong, ignoring this order...`,
        loggerCtx
      );
      return;
    }
    let picqerCustomer: CustomerData | undefined = undefined;
    if (order.customer.user) {
      // This means customer is registered, not a guest
      const name =
        order.shippingAddress.company ??
        order.shippingAddress.fullName ??
        `${order.customer.firstName} ${order.customer.lastName}`;
      picqerCustomer = await client.getOrCreateMinimalCustomer(
        order.customer.emailAddress,
        name
      );
    }
    const vatGroups = await client.getVatGroups();
    // Create or update each product of order
    const productInputs: OrderProductInput[] = [];
    for (const line of order.lines) {
      const vatGroup = vatGroups.find(
        (vg) => vg.percentage === line.productVariant.taxRateApplied.value
      );
      if (!vatGroup) {
        throw Error(
          `Can not find vat group ${line.productVariant.taxRateApplied.value}% for variant ${line.productVariant.sku}. Can not create order in Picqer`
        );
      }
      const picqerProduct = await client.createOrUpdateProduct(
        line.productVariant.sku,
        this.mapToProductInput(line.productVariant, vatGroup.idvatgroup)
      );
      productInputs.push({
        idproduct: picqerProduct.idproduct,
        amount: line.quantity,
      });
    }
    const orderInput = this.mapToOrderInput(
      order,
      productInputs,
      picqerCustomer?.idcustomer
    );
    const createdOrder = await client.createOrder(orderInput);
    await client.processOrder(createdOrder.idorder);
    Logger.info(
      `Created order "${order.code}" in status "processing" in Picqer with id ${createdOrder.idorder}`,
      loggerCtx
    );
    if (this.options.addPicqerOrderNote) {
      const note = this.options.addPicqerOrderNote(order);
      await client.addOrderNote(createdOrder.idorder, note);
      Logger.info(`Added custom note to order ${order.code}`, loggerCtx);
    }
  }

  /**
   * Find all variants by SKUS via raw connection for better performance
   */
  async findAllVariantsBySku(
    ctx: RequestContext,
    skus: string[]
  ): Promise<ProductVariant[]> {
    let skip = 0;
    const take = 1000;
    let hasMore = true;
    const allVariants: ProductVariant[] = [];
    while (hasMore) {
      const [variants, count] = await this.connection
        .getRepository(ctx, ProductVariant)
        .createQueryBuilder('variant')
        .leftJoin('variant.channels', 'channel')
        .where('channel.id = :channelId', { channelId: ctx.channelId })
        .andWhere('variant.sku IN(:...skus)', { skus })
        .andWhere('variant.deletedAt IS NULL')
        .skip(skip)
        .take(take)
        .getManyAndCount();
      allVariants.push(...variants);
      if (allVariants.length >= count) {
        hasMore = false;
      }
      skip += take;
    }
    return allVariants;
  }

  /**
   * Creates or updates products in Picqer based on the given variantIds.
   * Checks for existance of SKU in Picqer and updates if found.
   * If not found, creates a new product.
   */
  async handlePushVariantsJob(
    userCtx: RequestContext,
    variantIds?: ID[],
    productId?: ID
  ): Promise<void> {
    const ctx = this.createDefaultLanguageContext(userCtx);
    const client = await this.getClient(ctx);
    if (!client) {
      return;
    }
    // Get variants by ID or by ProductId
    let variants: ProductVariant[] | undefined;
    if (variantIds) {
      variants = await this.variantService.findByIds(ctx, variantIds);
    } else if (productId) {
      const product = await this.productService.findOne(ctx, productId);
      if (!product) {
        Logger.warn(
          `Could not find product with id ${productId} for push-variants job`,
          loggerCtx
        );
        return;
      }
      // Separate hydration is needed for taxRateApplied and variant prices
      await this.entityHydrator.hydrate(ctx, product, {
        relations: ['variants'],
        applyProductVariantPrices: true,
      });
      variants = product.variants;
      if (!product.enabled) {
        // Disable all variants if the product is disabled
        variants.forEach((v) => (v.enabled = false));
      }
    } else {
      throw Error('No variantIds or productId provided');
    }
    const vatGroups = await client.getVatGroups();
    await Promise.all(
      variants.map(async (variant) => {
        const vatGroup = vatGroups.find(
          (vg) => vg.percentage === variant.taxRateApplied.value
        );
        if (!vatGroup) {
          Logger.error(
            `Could not find vatGroup for taxRate ${variant.taxRateApplied.value} for variant ${variant.sku}. Not pushing this variant to Picqer`,
            loggerCtx
          );
          return;
        }
        try {
          const productInput = this.mapToProductInput(
            variant,
            vatGroup.idvatgroup
          );
          const picqerProduct = await client.createOrUpdateProduct(
            variant.sku,
            productInput
          );
          // Update images
          const shouldUpdateImages = !picqerProduct.images?.length;
          if (!shouldUpdateImages) {
            return;
          }
          const featuredImage = await this.getFeaturedImageAsBase64(
            ctx,
            variant
          );
          if (featuredImage) {
            await client.addImage(picqerProduct.idproduct, featuredImage);
            Logger.info(
              `Added image for variant ${variant.sku} in Picqer for channel ${ctx.channel.token}`,
              loggerCtx
            );
          }
        } catch (e: any) {
          throw new Error(
            `Error pushing variant ${variant.sku} to Picqer: ${e?.message}`
          );
        }
      })
    );
  }

  /**
   * Create or update config for the current channel and register webhooks after saving.
   */
  async upsertConfig(
    ctx: RequestContext,
    input: PicqerConfigInput
  ): Promise<PicqerConfig> {
    const repository = this.connection.getRepository(ctx, PicqerConfigEntity);
    const existing = await repository.findOne({
      channelId: String(ctx.channelId),
    });
    if (existing) {
      (input as Partial<PicqerConfigEntity>).id = existing.id;
    }
    await repository.save({
      ...input,
      channelId: ctx.channelId,
    } as PicqerConfigEntity);
    Logger.info(
      `Picqer config updated for channel ${ctx.channel.token} by user ${ctx.activeUserId}`,
      loggerCtx
    );
    const config = await repository.findOneOrFail({
      channelId: String(ctx.channelId),
    });
    await this.registerWebhooks(ctx, config).catch((e) =>
      Logger.error(
        `Failed to register webhooks for channel ${ctx.channel.token}: ${e?.message}`,
        loggerCtx
      )
    );
    return config;
  }

  /**
   * Create a new RequestContext with the default language of the current channel.
   */
  createDefaultLanguageContext(ctx: RequestContext): RequestContext {
    return new RequestContext({
      apiType: 'admin',
      isAuthorized: true,
      authorizedAsOwnerOnly: false,
      languageCode: ctx.channel.defaultLanguageCode,
      channel: ctx.channel,
    });
  }

  /**
   * Get a Picqer client for the current channel if the config is complete and enabled.
   */
  async getClient(
    ctx: RequestContext,
    config?: PicqerConfig
  ): Promise<PicqerClient | undefined> {
    if (!config) {
      config = await this.getConfig(ctx);
    }
    if (!config || !config.enabled) {
      Logger.info(
        `Picqer is not enabled for channel ${ctx.channel.token}`,
        loggerCtx
      );
      return;
    }
    if (
      !config.apiKey ||
      !config.apiEndpoint ||
      !config.storefrontUrl ||
      !config.supportEmail
    ) {
      Logger.warn(
        `Picqer config is incomplete for channel ${ctx.channel.token}`,
        loggerCtx
      );
      return;
    }
    return new PicqerClient(config as PicqerClientInput);
  }

  /**
   * Get featured asset as base64 string, but only when the asset is a png or jpeg.
   * If variant has no featured asset, it checks if the parent product has a featured asset.
   */
  async getFeaturedImageAsBase64(
    ctx: RequestContext,
    variant: ProductVariant
  ): Promise<string | undefined> {
    let asset = await this.assetService.getFeaturedAsset(ctx, variant);
    if (!asset?.preview) {
      // No featured asset on variant, try the parent product
      await this.entityHydrator.hydrate(ctx, variant, {
        relations: ['product'],
      });
      asset = await this.assetService.getFeaturedAsset(ctx, variant.product);
    }
    if (!asset?.preview) {
      // Still no asset, return undefined
      return;
    }
    const image = asset.preview;
    const hasAllowedExtension = ['png', 'jpg', 'jpeg'].some((extension) =>
      image.endsWith(extension)
    );
    if (!hasAllowedExtension) {
      // Only png, jpg and jpeg are supported by Picqer
      Logger.info(
        `featured asset for variant ${variant.sku} is not a png or jpeg, skipping`,
        loggerCtx
      );
      return;
    }
    const buffer =
      await this.configService.assetOptions.assetStorageStrategy.readFileToBuffer(
        image
      );
    return buffer.toString('base64');
  }

  /**
   * Get the Picqer config for the current channel based on given context
   */
  async getConfig(ctx: RequestContext): Promise<PicqerConfig | undefined> {
    const repository = this.connection.getRepository(ctx, PicqerConfigEntity);
    return repository.findOne({ channelId: String(ctx.channelId) });
  }

  /**
   * Validate Picqer credentials by requesting `stats` from Picqer
   */
  async testRequest(input: TestPicqerInput): Promise<boolean> {
    const client = new PicqerClient(input);
    // If getStatus() doesn't throw, the request is valid
    try {
      await client.getStats();
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Creates admin context for channel
   */
  async getCtxForChannel(channelToken: string): Promise<RequestContext> {
    const channel = await this.channelService.getChannelFromToken(channelToken);
    return new RequestContext({
      apiType: 'admin',
      isAuthorized: true,
      authorizedAsOwnerOnly: false,
      channel,
    });
  }

  mapToCustomerInput(customer: Customer, companyName?: string): CustomerInput {
    const customerName = `${customer.firstName} ${customer.lastName}`;
    return {
      name: companyName || customerName,
      contactname: customerName,
      emailaddress: customer.emailAddress,
      telephone: customer.phoneNumber,
      addresses: customer.addresses.map(this.mapToAddressInput),
    };
  }

  mapToAddressInput(address: Address): AddressInput {
    return {
      name: address.fullName,
      address: `${address.streetLine1} ${address.streetLine2}`,
      zipcode: address.postalCode,
      city: address.city,
      country: address.country?.code.toUpperCase(),
      defaultdelivery: address.defaultShippingAddress,
      defaultinvoice: address.defaultBillingAddress,
    };
  }

  mapToProductInput(variant: ProductVariant, vatGroupId: number): ProductInput {
    const additionalFields =
      this.options.pushProductVariantFields?.(variant) || {};
    if (!variant.sku) {
      throw Error(`Variant with ID ${variant.id} has no SKU`);
    }
    return {
      ...additionalFields,
      idvatgroup: vatGroupId,
      name: variant.name || variant.sku, // use SKU if no name set
      price: currency(variant.price / 100).value, // Convert to float with 2 decimals
      productcode: variant.sku,
      active: variant.enabled,
    };
  }

  mapToOrderInput(
    order: Order,
    products: OrderProductInput[],
    customerId?: number
  ): OrderInput {
    const shippingAddress = order.shippingAddress;
    // Check billing address existance based on PostalCode
    const billingAddress = order.billingAddress.postalCode
      ? order.billingAddress
      : order.shippingAddress;
    return {
      idcustomer: customerId, // If none given, this creates a guest order
      reference: order.code,
      deliveryname: shippingAddress.company || shippingAddress.fullName,
      deliverycontactname: shippingAddress.fullName,
      deliveryaddress: `${shippingAddress.streetLine1} ${shippingAddress.streetLine2}`,
      deliveryzipcode: shippingAddress.postalCode,
      deliverycountry: shippingAddress.country?.toUpperCase(),
      invoicename: billingAddress.company || billingAddress.fullName,
      invoicecontactname: billingAddress.fullName,
      invoiceaddress: `${shippingAddress.streetLine1} ${shippingAddress.streetLine2}`,
      invoicezipcode: shippingAddress.postalCode,
      invoicecity: shippingAddress.city,
      invoicecountry: shippingAddress.country?.toUpperCase(),
      products,
    };
  }
}
