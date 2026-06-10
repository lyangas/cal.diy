import type { NextApiRequest, NextApiResponse } from "next";

import { WEBAPP_URL_FOR_OAUTH } from "@calcom/lib/constants";
import { getSafeRedirectUrl } from "@calcom/lib/getSafeRedirectUrl";
import prisma from "@calcom/prisma";

import getInstalledAppPath from "../../_utils/getInstalledAppPath";
import createOAuthAppCredential from "../../_utils/oauth/createOAuthAppCredential";
import { decodeOAuthState } from "../../_utils/oauth/decodeOAuthState";
import { getTelemostAppKeys } from "../lib";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const state = decodeOAuthState(req);
  const { code, error, error_description } = req.query;

  if (error) {
    res.status(400).json({ message: (error_description as string) || (error as string) });
    return;
  }

  const { client_id, client_secret } = await getTelemostAppKeys();

  const result = await fetch("https://oauth.yandex.ru/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code as string,
      client_id,
      client_secret,
    }),
  });

  if (result.status !== 200) {
    let errorMessage = "Something is wrong with Yandex OAuth API";
    try {
      const responseBody = await result.json();
      errorMessage = responseBody.error_description || responseBody.error;
    } catch (e) {
      errorMessage = await result.clone().text();
    }

    res.status(400).json({ message: errorMessage });
    return;
  }

  const responseBody = await result.json();

  if (responseBody.error) {
    res.status(400).json({ message: responseBody.error_description || responseBody.error });
    return;
  }

  responseBody.expiry_date = Math.round(Date.now() + responseBody.expires_in * 1000);
  delete responseBody.expires_in;

  const userId = req.session?.user.id;
  if (!userId) {
    return res.status(404).json({ message: "No user found" });
  }

  /**
   * With this we take care of no duplicate telemost_video key for a single user
   * when creating a video room we only do findFirst so the if they have more than 1
   * others get ignored
   * */
  const existingCredentialTelemostVideo = await prisma.credential.findMany({
    select: {
      id: true,
    },
    where: {
      type: "telemost_video",
      userId: req.session?.user.id,
      appId: "telemost",
    },
  });

  // Making sure we only delete telemost_video
  const credentialIdsToDelete = existingCredentialTelemostVideo.map((item) => item.id);
  if (credentialIdsToDelete.length > 0) {
    await prisma.credential.deleteMany({ where: { id: { in: credentialIdsToDelete }, userId } });
  }

  await createOAuthAppCredential({ appId: "telemost", type: "telemost_video" }, responseBody, req);

  res.redirect(
    getSafeRedirectUrl(state?.returnTo) ?? getInstalledAppPath({ variant: "conferencing", slug: "telemost" })
  );
}
