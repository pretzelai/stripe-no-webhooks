type Plan = {
  id?: string;
  name: string;
  description?: string;
  price: {
    id?: string;
    amount: number;
    currency: string;
    interval: "month" | "year" | "week";
  }[];
};

export type BillingConfig = {
  plans?: Plan[];
};
