export type PriceInterval = "month" | "year" | "week" | "one_time";

export type Price = {
  id?: string;
  amount: number;
  currency: string;
  interval: PriceInterval;
};

export type Plan = {
  id?: string;
  name: string;
  description?: string;
  price: Price[];
};

export type BillingConfig = {
  test?: {
    plans?: Plan[];
  };
  production?: {
    plans?: Plan[];
  };
};
