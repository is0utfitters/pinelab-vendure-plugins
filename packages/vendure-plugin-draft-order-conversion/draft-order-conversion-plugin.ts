import { OnApplicationBootstrap } from '@nestjs/common';
import { ActiveOrderService, EventBus, Logger, Order, OrderService, OrderState, OrderStateTransitionError, OrderStateTransitionEvent, PluginCommonModule, RequestContext, TransactionalConnection, VendurePlugin } from '@vendure/core';
import { filter } from 'rxjs/operators';

@VendurePlugin({
    imports: [PluginCommonModule]
})
export class DraftOrderConversionPlugin implements OnApplicationBootstrap {

  constructor(private eventBus: EventBus,
              private orderService: OrderService,
              private activeOrderService: ActiveOrderService,
              private rawConnection: TransactionalConnection,
              private connection: TransactionalConnection,
  ) {}

  async onApplicationBootstrap() {
    this.eventBus
      .ofType(OrderStateTransitionEvent)
      .pipe(
        filter(event => event.fromState === 'Draft'),
        filter(event => event.toState === 'ArrangingPayment'),
      )
      .subscribe(async (event) => {
        console.log(event.fromState+'->'+ event.toState);
        const { order, ctx } = event;
        console.log(order.code);
        let activeOrder = await this.connection
                                  .getRepository(ctx, Order)
                                  .findOne({ customer: order.customer, active: true });
        if(activeOrder != undefined) {
          console.log("Existing active order: "+activeOrder.code+" for customer: "+activeOrder.customer?.emailAddress);
          await this.setOrderActiveState(ctx, activeOrder, false);
          await this.setOrderState(ctx, activeOrder, 'Draft');
        }

        await this.setOrderState(ctx, order, 'AddingItems');
        await this.setOrderActiveState(ctx, order, true);
      });
  }

  async setOrderActiveState(
    ctx: RequestContext,
    order: Order,
    active: boolean = true
  ) {
    try {
      await this.connection
      .getRepository(ctx, Order)
      .update(
        { id: order.id, }, 
        { active: active }
      );
    } catch (error) {
      
    }
    Logger.info(
      `Successfully transitioned order ${order.code} to active`
    );
  }

  async setOrderState(
    ctx: RequestContext,
    order: Order,
    state: OrderState
  ) {
    const transitionToStateResult = await this.orderService.transitionToState(
      ctx,
      order.id,
      state
    );
    if (transitionToStateResult instanceof OrderStateTransitionError) {
      throw Error(
        `Error transitioning order ${order.code} from ${transitionToStateResult.fromState} to ${transitionToStateResult.toState}: ${transitionToStateResult.message}`
      );
    }
    return transitionToStateResult;
  }
}
