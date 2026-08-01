import { PairingCodeCreateResponseSchema } from "@morrow/hosted-contracts";
import { authedPost } from "./client.js";

export const pairingApi = {
  createCode(token: string) {
    return authedPost("/api/pair/create", token, PairingCodeCreateResponseSchema);
  },
};
