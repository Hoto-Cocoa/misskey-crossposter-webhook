import { SendTweetV1Params, SendTweetV2Params, TwitterApi, TwitterApiTokens } from 'twitter-api-v2';

type ValidTwitterVersion = 'v1' | 'v2';

export interface TwitterServiceTweetOptions {
  replyTo?: string | undefined;
  isRetry?: boolean | undefined;
  mediaIds?: string[] | undefined;
}

export class TwitterService {
  private version: ValidTwitterVersion = 'v1';
  private client: TwitterApi;

  constructor(version: ValidTwitterVersion, conf: TwitterApiTokens) {
    this.version = version;
    this.client = new TwitterApi(conf);
  }

  async tweet(text: string, options: Partial<TwitterServiceTweetOptions> = {}): Promise<string> {
    let tweetId: string;

    try {
      switch (this.version) {
        case 'v1': {
          const opt: Partial<SendTweetV1Params> = {};

          if (options.replyTo) {
            opt.in_reply_to_status_id = options.replyTo;
          }

          if (options.mediaIds?.length) {
            opt.media_ids = options.mediaIds.join(',');
          }

          const tweet = await this.client.v1.tweet(text, opt);

          console.log(tweet);

          tweetId = tweet.id_str;

          break;
        }

        case 'v2': {
          const opt: Partial<SendTweetV2Params> = {};

          if (options.replyTo) {
            opt.reply = {
              in_reply_to_tweet_id: options.replyTo,
            };
          }

          if (options.mediaIds?.length) {
            opt.media = {
              media_ids: options.mediaIds,
            };
          }

          const tweet = await this.client.v2.tweet(text, opt);

          console.log(tweet);

          tweetId = tweet.data.id;

          break;
        }

        default: {
          throw new Error('Invalid Twitter API version');
        }
      }

      return tweetId;
    } catch (e) {
      const error = e as any;

      if (error.response?.statusCode === 503 && !options.isRetry) {
        return await this.tweet(text, { ...options, isRetry: true });
      }

      throw e;
    }
  }

  async uploadMedia(media: Buffer, type: string): Promise<string> {
    return await this.client.v1.uploadMedia(media, {
      mimeType: type,
    });
  }
}
