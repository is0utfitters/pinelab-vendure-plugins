import { gql } from 'graphql-tag';

/**
 * Needed for gql codegen
 */
const _scalar = gql`
  scalar DateTime
`;

const sharedTypes = gql`
  enum SubscriptionInterval {
    week
    month
  }
  enum SubscriptionStartMoment {
    start_of_billing_interval
    end_of_billing_interval
    time_of_purchase
    fixed_startdate
  }
  type StripeSubscriptionSchedule {
    id: ID!
    createdAt: DateTime
    updatedAt: DateTime
    name: String!
    downpaymentWithTax: Int!
    durationInterval: SubscriptionInterval!
    durationCount: Int!
    startMoment: SubscriptionStartMoment!
    paidUpFront: Boolean!
    billingInterval: SubscriptionInterval!
    billingCount: Int!
    fixedStartDate: DateTime
    useProration: Boolean
    autoRenew: Boolean
  }
  input UpsertStripeSubscriptionScheduleInput {
    id: ID
    name: String!
    downpaymentWithTax: Int!
    durationInterval: SubscriptionInterval!
    durationCount: Int!
    startMoment: SubscriptionStartMoment!
    billingInterval: SubscriptionInterval!
    billingCount: Int!
    fixedStartDate: DateTime
    useProration: Boolean
    autoRenew: Boolean
  }
`;

export const shopSchemaExtensions = gql`
  ${sharedTypes}

  extend type OrderLine {
    subscriptionPricing: StripeSubscriptionPricing
  }

  type StripeSubscriptionPricing {
    variantId: String!
    downpaymentWithTax: Int!
    totalProratedAmountWithTax: Int!
    proratedDays: Int!
    dayRateWithTax: Int!
    recurringPriceWithTax: Int!
    interval: SubscriptionInterval!
    intervalCount: Int!
    amountDueNowWithTax: Int!
    subscriptionStartDate: DateTime!
    subscriptionEndDate: DateTime
    schedule: StripeSubscriptionSchedule!
  }
  input StripeSubscriptionPricingInput {
    productVariantId: ID!
    startDate: DateTime
    downpaymentWithTax: Int
  }
  extend type Query {
    """
    Preview the pricing model of a given subscription.
    Start date and downpayment are optional: if not supplied, the subscriptions default will be used.
    """
    stripeSubscriptionPricing(
      input: StripeSubscriptionPricingInput
    ): StripeSubscriptionPricing
    stripeSubscriptionPricingForProduct(
      productId: ID!
    ): [StripeSubscriptionPricing!]!
  }
  extend type Mutation {
    createStripeSubscriptionIntent: String!
  }
`;

export const adminSchemaExtensions = gql`
  ${sharedTypes}

  extend enum HistoryEntryType {
    STRIPE_SUBSCRIPTION_NOTIFICATION
  }

  extend type Query {
    stripeSubscriptionSchedules: [StripeSubscriptionSchedule!]!
  }
  extend type Mutation {
    upsertStripeSubscriptionSchedule(
      input: UpsertStripeSubscriptionScheduleInput!
    ): StripeSubscriptionSchedule!
    deleteStripeSubscriptionSchedule(scheduleId: ID!): Boolean
  }
`;
