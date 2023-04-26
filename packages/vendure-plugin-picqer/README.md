# Vendure Picqer Plugin

![Vendure version](https://img.shields.io/npm/dependency-version/vendure-plugin-picqer/dev/@vendure/core)

!! This plugin is still being developed and it's still incomplete!

Vendure plugin to sync orders, stock and catalogue with Picqer.com order pick platform.

- Sync placed orders to Picqer
- Sync all products to Picqer
- Pull stock levels from Picqer into Vendure

The plugin follows these principles:

- Vendure should be considered the source of truth for product presentation: Assets, descriptions and names are pushed from Vendure to Picqer
- Picqer should be considered the source of truth for stock levels: Stock levels are pulled from Picqer into Vendure

## Getting started

Add the plugin to your `vendure-config.ts`

```ts
// vendure-config.ts

import {PicqerPlugin} from 'vendure-plugin-picqer'

...
plugins: [
  PicqerPlugin.init({
    vendureHost: 'https://example-vendure.io'
    /**
     * Optional strategy to push additional fields to Picqer.
     * This example pushes variant.sku as product.barcode to Picqer
     */
    pushFieldsToPicqer: (variant) => ({ barcode: variant.sku })
  }),
  AdminUiPlugin.init({
    port: 3002,
    route: 'admin',
    app: compileUiExtensions({
      outputPath: path.join(__dirname, '__admin-ui'),
      extensions: [
        PicqerPlugin.ui,
        ... // your other plugin UI extensions
      ],
    }),
  }),
... // your other plugins
]

```

Start the server and set the fulfillment handler to `picqer: Fulfill with Picqer` for all shipping methods that should be handled via Picqer.

## Stock levels

Stock levels are updated in Vendure on

1. Full sync via the Admin UI
2. Or, on incoming webhook from Picqer

## Orders

1. Orders are pushed to Picqer with status `processing` when an order is placed in Vendure. The Vendure order will remain in `Payment Settled` and no fulfillments are created.
2. Products are fulfilled in Vendure based on the products in the incoming `picklist.closed` events from Picqer. This can result in the order being `Shipped` or `PartiallyShipped`
3. Currently, when the order is `Shipped` it will automatically transition to `Delivered`, because we do not receive delivery events from Picqer.

### Current order flow:

![Current order flow](https://www.plantuml.com/plantuml/png/bOwn2i9038RtFaNef8E27Jj81n-W8BWVTr4FqqjDSe9lxnLQK73GBI7_z_tfr9nO7gWwOGfP43PxwAE_eq0BVTOhi8IoS9g7aPp70PF1ge5HE6HlklwA7z706EgIygWQqwMkvcE9BKGx0JUAQbjFh1ZWpBAOORUOFv6Ydl-P2ded5XtH4mv8yO62uV-cvfUcDtytHGPw0G00)

[edit](https://www.plantuml.com/plantuml/uml/bOwn2i9038RtFaNef8E27Jj81n-W8BWVTr4FqqjDSe9lxnLQK73GBI7_z_tfr9nO7gWwOGfP43PxwAE_eq0BVTOhi8IoS9g7aPp70PF1ge5HE6HlklwA7z706EgIygWQqwMkvcE9BKGx0JUAQbjFh1ZWpBAOORUOFv6Ydl-P2ded5XtH4mv8yO62uV-cvfUcDtytHGPw0G00)

### Desired order flow (future plans, not implemented yet):

![Future order flow](https://www.plantuml.com/plantuml/png/fP3DIiKm48NtVOgXArqec6KNSa4Ve731VKX6Rt3ousGYtBUtgGsKwiBWBapEcVFDEMNHBCNJy8B15aQuUuJPcGzac60k-GAHBJB4i3qIQOCUWy2DWiJH5YFvzbVx6GKamhYe3ERimjiuR9-Bx7nnAIspf-YJ3bUOricwsJ1gGGklaLi4FEoiBMogMU_aijmRYlc7e-dsbagrdLBPPitYDD7rcmVjE1p03e5jELWazucCjY_ckTd-qONgxaBz1RAl0TNNmExkKvLu-W80)

[edit](https://www.plantuml.com/plantuml/uml/fP3DIiKm48NtVOgXArqec6KNSa4Ve731VKX6Rt3ousGYtBUtgGsKwiBWBapEcVFDEMNHBCNJy8B15aQuUuJPcGzac60k-GAHBJB4i3qIQOCUWy2DWiJH5YFvzbVx6GKamhYe3ERimjiuR9-Bx7nnAIspf-YJ3bUOricwsJ1gGGklaLi4FEoiBMogMU_aijmRYlc7e-dsbagrdLBPPitYDD7rcmVjE1p03e5jELWazucCjY_ckTd-qONgxaBz1RAl0TNNmExkKvLu-W80)

## Caveats

- Due to limitation of the Picqer API, the plugin only uploads images if no images exist for the product in Picqer.
- Stock is updated directly on a variant, so no `StockMovementEvents` are emitted by Vendure when variants are updated in Vendure by the full sync.
- This plugin automatically creates webhooks and deactivates old ones. Webhooks are created when you save your config.
