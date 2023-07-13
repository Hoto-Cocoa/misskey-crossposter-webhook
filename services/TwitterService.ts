import { SendTweetV1Params, SendTweetV2Params, TwitterApi, TwitterApiTokens } from 'twitter-api-v2';

type ValidTwitterVersion = 'v1' | 'v2';

interface TwitterServiceTweetOptions {
  replyTo?: string;
  isRetry?: boolean;
  mediaIds?: string[];
}

export class TwitterService {
  private version: ValidTwitterVersion = 'v1';
  private client: TwitterApi;

  constructor(version: ValidTwitterVersion, conf: TwitterApiTokens) {
    this.version = version;
    this.client = new TwitterApi(conf);
  }

  async tweet(text: string, options?: TwitterServiceTweetOptions): Promise<string> {
    let tweetId: string;

    try {
      switch(this.version) {
        case 'v1': {
          const opt = {} as Partial<SendTweetV1Params>;

          if (options?.replyTo) {
            opt.in_reply_to_status_id = options.replyTo;
          }

          if (options?.mediaIds?.length > 0) {
            opt.media_ids = options.mediaIds.join(',');
          }

          const tweet = await this.client.v1.tweet(text, opt);

          console.log(tweet);

          tweetId = tweet.id_str;

          break;
        }

        case 'v2': {
          const opt = {} as Partial<SendTweetV2Params>;

          if (options?.replyTo) {
            opt.reply = {
              in_reply_to_tweet_id: options.replyTo,
            };
          }

          if (options?.mediaIds?.length > 0) {
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
      if (e.response?.statusCode === 503 && !options.isRetry) {
        return await this.tweet(text, Object.assign({}, options, { isRetry: true }));
      }

      throw e;
    }
  }

  async uploadMedia(media: Buffer): Promise<string> {
    return await this.client.v1.uploadMedia(media);
  }
}
