import { TwitterApiTokens } from 'twitter-api-v2';
import * as Misskey from 'misskey-js';

export interface User {
  misskeyId: string;
  secret: string;
  baseProfile: string;
  twitterApiConfs: UserTwitterApiConf[];
  confs: {
    enableRenote: boolean;
    enableTags: boolean;
    skipLinkRequired: boolean;
    alwaysIncludeLink: boolean;
    skipHashtag: string;
    cwTitleOnly: boolean;
    excludeNsfw: boolean;
  };
}

export interface UserTwitterApiConf {
  visibility: Misskey.entities.Note['visibility'];
  version: 'v1' | 'v2';
  tokens: TwitterApiTokens;
}
