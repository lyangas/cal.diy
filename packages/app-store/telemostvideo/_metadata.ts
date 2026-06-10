import type { AppMeta } from "@calcom/types/App";

export const metadata = {
  linkType: "dynamic",
  name: "Yandex Telemost",
  description:
    "Yandex Telemost is a video conferencing service by Yandex 360. Create video meetings with a unique join link for every booking. Connecting an account requires Yandex 360 for Business (the Telemost API is only available to business accounts on an organization domain).",
  type: "telemost_video",
  categories: ["conferencing"],
  variant: "conferencing",
  logo: "icon.svg",
  publisher: "Cal.diy",
  url: "https://telemost.yandex.ru/",
  category: "conferencing",
  slug: "telemost",
  title: "Yandex Telemost",
  email: "help@cal.com",
  appData: {
    location: {
      default: false,
      linkType: "dynamic",
      type: "integrations:telemost",
      label: "Yandex Telemost",
    },
  },
  dirName: "telemostvideo",
  isOAuth: true,
} as AppMeta;

export default metadata;
