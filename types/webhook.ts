import * as Misskey from 'misskey-js';

export type WebhookNote = Misskey.entities.Note & {
  tags?: string[];
  mentions?: string[];
};
