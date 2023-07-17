import { SendTweetV1Params, SendTweetV2Params, TweetV1, TweetV2PostTweetResult, TwitterApiTokens } from 'twitter-api-v2';
import { TwitterService } from '../../services/TwitterService.js';
import nock from 'nock';
import querystring from 'querystring';

let twitterService: TwitterService;

const tokens: TwitterApiTokens = {
  appKey: 'test',
  appSecret: 'test',
  accessToken: 'test',
  accessSecret: 'test',
};

describe('TwitterService', () => {
  beforeEach(() => {
    twitterService = new TwitterService('v1', tokens);
  });

  describe('tweet', () => {
    it('should post a tweet (v1)', async () => {
      const tweetText = 'Test tweet';

      const scope = nock('https://api.twitter.com')
        .post('/1.1/statuses/update.json')
        .reply(200, (uri, body) => {
          const data = querystring.parse(body as string) as unknown as SendTweetV1Params;

          expect(data.status).toEqual(tweetText);

          return { id_str: 'testTweetId' } as TweetV1;
        });

      const tweetId = await twitterService.tweet(tweetText);

      scope.done();

      expect(tweetId).toEqual('testTweetId');
    });

    it('should post a tweet with media (v1)', async () => {
      const tweetText = 'Test tweet';
      const mediaIds = ['testMediaId1', 'testMediaId2'];

      const scope = nock('https://api.twitter.com')
        .post('/1.1/statuses/update.json')
        .reply(200, (uri, body) => {
          const data = querystring.parse(body as string) as unknown as SendTweetV1Params;

          expect(data.media_ids).toEqual(mediaIds.join(','));
          expect(data.status).toEqual(tweetText);

          return { id_str: 'testTweetId' } as TweetV1;
        });

      const tweetId = await twitterService.tweet(tweetText, { mediaIds });

      scope.done();

      expect(tweetId).toEqual('testTweetId');
    });

    it('should post a tweet as a reply (v1)', async () => {
      const tweetText = 'Test tweet';
      const replyTo = 'testReplyTo';

      const scope = nock('https://api.twitter.com')
        .post('/1.1/statuses/update.json')
        .reply(200, (uri, body) => {
          const data = querystring.parse(body as string) as unknown as SendTweetV1Params;

          expect(data.in_reply_to_status_id).toEqual(replyTo);
          expect(data.status).toEqual(tweetText);

          return { id_str: 'testTweetId' } as TweetV1;
        });

      const tweetId = await twitterService.tweet(tweetText, { replyTo });

      scope.done();

      expect(tweetId).toEqual('testTweetId');
    });

    it('should post a tweet (v2)', async () => {
      const tweetText = 'Test tweet';

      const scope = nock('https://api.twitter.com')
        .post('/2/tweets')
        .reply(200, (uri, body) => {
          const data = body as SendTweetV2Params;

          expect(data.text).toEqual(tweetText);

          return { data: { id: 'testTweetId' } } as TweetV2PostTweetResult;
        });

      twitterService = new TwitterService('v2', tokens);

      const tweetId = await twitterService.tweet(tweetText);

      scope.done();

      expect(tweetId).toEqual('testTweetId');
    });

    it('should post a tweet with media (v2)', async () => {
      const tweetText = 'Test tweet';
      const mediaIds = ['testMediaId1', 'testMediaId2'];

      const scope = nock('https://api.twitter.com')
        .post('/2/tweets')
        .reply(200, (uri, body) => {
          const data = body as SendTweetV2Params;

          expect(data.media?.media_ids).toEqual(mediaIds);
          expect(data.text).toEqual(tweetText);

          return { data: { id: 'testTweetId' } } as TweetV2PostTweetResult;
        });

      twitterService = new TwitterService('v2', tokens);

      const tweetId = await twitterService.tweet(tweetText, { mediaIds });

      scope.done();

      expect(tweetId).toEqual('testTweetId');
    });

    it('should post a tweet as a reply (v2)', async () => {
      const tweetText = 'Test tweet';
      const replyTo = 'testReplyTo';

      const scope = nock('https://api.twitter.com')
        .post('/2/tweets')
        .reply(200, (uri, body) => {
          const data = body as SendTweetV2Params;

          expect(data.reply?.in_reply_to_tweet_id).toEqual(replyTo);
          expect(data.text).toEqual(tweetText);

          return { data: { id: 'testTweetId' } } as TweetV2PostTweetResult;
        });

      twitterService = new TwitterService('v2', tokens);

      const tweetId = await twitterService.tweet(tweetText, { replyTo });

      scope.done();

      expect(tweetId).toEqual('testTweetId');
    });

    it('should throw error if api version is unknown', async () => {
      twitterService = new TwitterService('v0' as 'v1', tokens);

      await expect(twitterService.tweet('test')).rejects.toThrowError();
    });

    it('should retry if service unavailable error occurs', async () => {
      const tweetText = 'Test tweet';

      const scope = nock('https://api.twitter.com')
        .post('/1.1/statuses/update.json')
        .reply(503)
        .post('/1.1/statuses/update.json')
        .reply(200, { id_str: 'testTweetId' } as TweetV1);

      const tweetId = await twitterService.tweet(tweetText);

      scope.done();

      expect(tweetId).toEqual('testTweetId');
    });
  });

  describe('uploadMedia', () => {
    it('should upload media and return media ID', async () => {
      const mediaBuffer: Buffer = Buffer.from('test');

      const scope = nock('https://upload.twitter.com')
        .post('/1.1/media/upload.json')
        .times(3)
        .reply(200, { media_id_string: 'testMediaId' });

      const mediaId = await twitterService.uploadMedia(mediaBuffer, 'image/png');

      scope.done();

      expect(mediaId).toEqual('testMediaId');
    });
  });
});
