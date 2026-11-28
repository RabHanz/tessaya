/** Her Sleeve's acts as the phone opens them: always handed to him to finish (he presses call or send). */
const NUMBER = /^\+?[\d\s().-]{3,32}$/;
const digits = (n: string) => n.replace(/[^\d+]/g, "");

/** A call to open, or null when the value is not a phone number. */
export const callUrl = (value: string): string | null =>
  NUMBER.test(value.trim()) ? `tel:${digits(value)}` : null;

/** A text to open from "number: message"; iOS joins the body with "&", Android with "?". */
export const messageUrl = (value: string, ios: boolean): string | null => {
  const at = value.indexOf(":");
  const number = (at < 0 ? value : value.slice(0, at)).trim();
  const body = at < 0 ? "" : value.slice(at + 1).trim();
  if (!NUMBER.test(number)) return null;
  return body === ""
    ? `sms:${digits(number)}`
    : `sms:${digits(number)}${ios ? "&" : "?"}body=${encodeURIComponent(body)}`;
};
