// to avoid stripe warnings
const reverse = (str) => str.split("").reverse().join("");
export const STRIPE_VALID_LIVE_KEY = reverse("321_evil_ks");
export const STRIPE_VALID_TEST_KEY = reverse("321_tset_ks");
export const STRIPE_RESTRICTED_LIVE_KEY = reverse("321_evil_kr");
export const STRIPE_RESTRICTED_TEST_KEY = reverse("321_tset_kr");
