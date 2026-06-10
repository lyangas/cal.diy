import { z } from "zod";

import {
  APP_CREDENTIAL_SHARING_ENABLED,
  CREDENTIAL_SYNC_ENDPOINT,
  CREDENTIAL_SYNC_SECRET,
  CREDENTIAL_SYNC_SECRET_HEADER_NAME,
} from "@calcom/lib/constants";
import logger from "@calcom/lib/logger";
import { getPiiFreeCalendarEvent } from "@calcom/lib/piiFreeData";
import { safeStringify } from "@calcom/lib/safeStringify";
import { prisma } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { PartialReference } from "@calcom/types/EventManager";
import type { VideoApiAdapter, VideoCallData } from "@calcom/types/VideoApiAdapter";

import { invalidateCredential } from "../../_utils/invalidateCredential";
import { OAuthManager } from "../../_utils/oauth/OAuthManager";
import { getTokenObjectFromCredential } from "../../_utils/oauth/getTokenObjectFromCredential";
import { markTokenAsExpired } from "../../_utils/oauth/markTokenAsExpired";
import { metadata } from "../_metadata";
import { getTelemostAppKeys } from "./getTelemostAppKeys";

const log = logger.getSubLogger({ prefix: ["app-store/telemostvideo/lib/VideoApiAdapter"] });

/** @link https://yandex.ru/dev/telemost/doc/ru/conference-create */
const telemostConferenceSchema = z.object({
  id: z.string(),
  join_url: z.string(),
});

export type TelemostConference = z.infer<typeof telemostConferenceSchema>;

const TELEMOST_API_URL = "https://cloud-api.yandex.net/v1/telemost-api";

const TelemostVideoApiAdapter = (credential: CredentialPayload): VideoApiAdapter => {
  const tokenResponse = getTokenObjectFromCredential(credential);

  const fetchTelemostApi = async (endpoint: string, options?: RequestInit) => {
    const auth = new OAuthManager({
      credentialSyncVariables: {
        APP_CREDENTIAL_SHARING_ENABLED: APP_CREDENTIAL_SHARING_ENABLED,
        CREDENTIAL_SYNC_ENDPOINT: CREDENTIAL_SYNC_ENDPOINT,
        CREDENTIAL_SYNC_SECRET: CREDENTIAL_SYNC_SECRET,
        CREDENTIAL_SYNC_SECRET_HEADER_NAME: CREDENTIAL_SYNC_SECRET_HEADER_NAME,
      },
      resourceOwner: {
        type: "user",
        id: credential.userId,
      },
      appSlug: metadata.slug,
      currentTokenObject: tokenResponse,
      fetchNewTokenObject: async ({ refreshToken }: { refreshToken: string | null }) => {
        if (!refreshToken) {
          return null;
        }
        const { client_id, client_secret } = await getTelemostAppKeys();
        return fetch("https://oauth.yandex.ru/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id,
            client_secret,
          }),
        });
      },
      isTokenObjectUnusable: async function (response) {
        const myLog = logger.getSubLogger({ prefix: ["telemostvideo:isTokenObjectUnusable"] });
        myLog.info(safeStringify({ status: response.status, ok: response.ok }));
        if (!response.ok) {
          let responseBody;
          try {
            responseBody = await response.json();
          } catch (e) {
            myLog.error("Error parsing Yandex OAuth response", safeStringify(e));
            return null;
          }
          myLog.error(
            "Yandex token refresh failed",
            safeStringify({
              status: response.status,
              error: responseBody.error,
              errorDescription: responseBody.error_description,
            })
          );

          // invalid_grant means the refresh token is revoked or expired — re-connection required
          if (responseBody.error === "invalid_grant" || responseBody.error === "invalid_request") {
            return { reason: responseBody.error };
          }
        }
        return null;
      },
      isAccessTokenUnusable: async function (response) {
        const myLog = logger.getSubLogger({ prefix: ["telemostvideo:isAccessTokenUnusable"] });
        myLog.info(safeStringify({ status: response.status, ok: response.ok }));
        // Telemost API responds with 401 UnauthorizedError when the access token is invalid
        if (response.status === 401) {
          let reason = "Unauthorized";
          try {
            const responseBody = await response.json();
            reason = responseBody.error ?? reason;
          } catch (e) {
            // Keep the default reason if the body is not JSON
          }
          return { reason };
        }
        return null;
      },
      invalidateTokenObject: () => invalidateCredential(credential.id),
      expireAccessToken: () => markTokenAsExpired(credential),
      updateTokenObject: async (newTokenObject) => {
        await prisma.credential.update({
          where: {
            id: credential.id,
          },
          data: {
            // z.passthrough() is not allowed in Prisma, but we know this is trusted.
            key: newTokenObject as unknown as Prisma.InputJsonValue,
          },
        });
      },
    });

    // Make sure the token is fresh, then pass it in Yandex's `OAuth <token>` header format
    // (our headers spread overrides the default `Bearer` Authorization header).
    const { token } = await auth.getTokenObjectOrFetch();

    const { json } = await auth.request({
      url: `${TELEMOST_API_URL}/${endpoint}`,
      options: {
        method: "GET",
        ...options,
        headers: {
          Authorization: `OAuth ${token.access_token}`,
          "Content-Type": "application/json",
          ...options?.headers,
        },
      },
    });

    return json;
  };

  return {
    /** Telemost rooms are not time-bound, so they never block availability */
    getAvailability: async () => {
      return [];
    },
    createMeeting: async (event: CalendarEvent): Promise<VideoCallData> => {
      try {
        const response = await fetchTelemostApi("conferences", {
          method: "POST",
          body: JSON.stringify({
            // No waiting room: guests booking through Cal must be able to join directly
            waiting_room_level: "PUBLIC",
          }),
        });

        const result = telemostConferenceSchema.safeParse(response);

        if (result.success && result.data.join_url) {
          return {
            type: "telemost_video",
            id: result.data.id,
            password: "",
            url: result.data.join_url,
          };
        }

        // Surface the most common failure clearly: the account has no Yandex 360 for Business
        const apiError = (response as { error?: string; message?: string }) ?? {};
        if (apiError.error === "ApiRestrictedToOrganizations") {
          throw new Error(
            "Telemost API is restricted to Yandex 360 for Business accounts on an organization domain"
          );
        }
        throw new Error(`Failed to create meeting. Response is ${JSON.stringify(response)}`);
      } catch (err) {
        log.error(
          "Telemost meeting creation failed",
          safeStringify({ error: safeStringify(err), event: getPiiFreeCalendarEvent(event) })
        );
        throw new Error("Unexpected error");
      }
    },
    /**
     * The Telemost API has no conferences.delete permission, and a room without
     * participants holds no resources — deleting the booking just drops the link.
     */
    deleteMeeting: async (): Promise<void> => {
      return Promise.resolve();
    },
    /** Telemost rooms are not time-bound — rescheduling keeps the same join link */
    updateMeeting: (bookingRef: PartialReference): Promise<VideoCallData> => {
      return Promise.resolve({
        type: "telemost_video",
        id: bookingRef.meetingId as string,
        password: bookingRef.meetingPassword as string,
        url: bookingRef.meetingUrl as string,
      });
    },
  };
};

export default TelemostVideoApiAdapter;
