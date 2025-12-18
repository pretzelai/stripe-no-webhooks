type Plan = {
  id?: string;
  name: string;
  description?: string;
  interval: "month" | "year" | "week";
  price: number;
  currency: string;
};

export type BillingConfig = {
  plans?: Plan[];
};
