import type { NextApiRequest } from "next";
import { stringify } from "node:querystring";

import { WEBAPP_URL_FOR_OAUTH } from "@calcom/lib/constants";
import { defaultHandler } from "@calcom/lib/server/defaultHandler";
import { defaultResponder } from "@calcom/lib/server/defaultResponder";
import prisma from "@calcom/prisma";

import { encodeOAuthState } from "../../_utils/oauth/encodeOAuthState";
import { getTelemostAppKeys } from "../lib";

async function handler(req: NextApiRequest) {
  // Get user
  await prisma.user.findFirstOrThrow({
    where: {
      id: req.session?.user?.id,
    },
    select: {
      id: true,
    },
  });

  const { client_id } = await getTelemostAppKeys();
  const state = encodeOAuthState(req);

  const params = {
    response_type: "code",
    client_id,
    redirect_uri: `${WEBAPP_URL_FOR_OAUTH}/api/integrations/telemostvideo/callback`,
    state,
    // Always show the account chooser so users can pick their Yandex 360 business account
    force_confirm: "yes",
  };
  const query = stringify(params);
  const url = `https://oauth.yandex.ru/authorize?${query}`;
  return { url };
}

export default defaultHandler({
  GET: Promise.resolve({ default: defaultResponder(handler) }),
});
