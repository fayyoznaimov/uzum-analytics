export const GoalMetric = { REVENUE:'REVENUE', PROFIT:'PROFIT', ORDERS:'ORDERS', UNITS:'UNITS', ROAS:'ROAS' } as const;
export type GoalMetric = typeof GoalMetric[keyof typeof GoalMetric];
export const GoalPeriod = { WEEKLY:'WEEKLY', MONTHLY:'MONTHLY', CUSTOM:'CUSTOM' } as const;
export type GoalPeriod = typeof GoalPeriod[keyof typeof GoalPeriod];
export const SupplyType = { FBO:'FBO', FBS:'FBS' } as const;
export type SupplyType = typeof SupplyType[keyof typeof SupplyType];
export const IntegrationType = { UZUM:'UZUM', UZUM_INTERNAL:'UZUM_INTERNAL', OPENAI:'OPENAI', ANTHROPIC:'ANTHROPIC', TELEGRAM:'TELEGRAM' } as const;
export type IntegrationType = typeof IntegrationType[keyof typeof IntegrationType];
export const IntegrationStatus = { NOT_CONFIGURED:'NOT_CONFIGURED', CONNECTED:'CONNECTED', ERROR:'ERROR' } as const;
export type IntegrationStatus = typeof IntegrationStatus[keyof typeof IntegrationStatus];

export namespace Prisma {
  export type InputJsonValue = any;
  export type JsonValue = any;
  export type PrismaPromise<T> = Promise<T>;
  export type ReviewWhereInput = any;
  export type OrderUpdateInput = any;
  export type OrderGetPayload<T> = any;
  export type OrderItemGetPayload<T> = any;
}

export class PrismaClient {
  [key: string]: any;
  $connect(): Promise<void> { return Promise.resolve(); }
  $disconnect(): Promise<void> { return Promise.resolve(); }
}
