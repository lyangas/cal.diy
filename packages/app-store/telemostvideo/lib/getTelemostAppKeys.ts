import { z } from "zod";

import getAppKeysFromSlug from "../../_utils/getAppKeysFromSlug";

const telemostAppKeysSchema = z.object({
  client_id: z.string(),
  client_secret: z.string(),
});

export const getTelemostAppKeys = async () => {
  const appKeys = await getAppKeysFromSlug("telemost");
  return telemostAppKeysSchema.parse(appKeys);
};
