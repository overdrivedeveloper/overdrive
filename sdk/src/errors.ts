/** An intent whose target or approval spender is not an Overdrive contract. Nothing was signed or sent. */
export class OverdriveIntentMismatch extends Error {
  constructor(message: string, readonly field: string, readonly address: string) {
    super(message);
    this.name = "OverdriveIntentMismatch";
  }
}
