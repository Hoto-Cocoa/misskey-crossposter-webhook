import { TwitterApiTokens } from 'twitter-api-v2';
import { TwitterService } from '../../services/TwitterService.js';
import nock from 'nock';

let twitterService: TwitterService;

const tokens: TwitterApiTokens = {
  appKey: 'test',
  appSecret: 'test',
  accessToken: 'test',
  accessSecret: 'test',
};

beforeEach(() => {
  twitterService = new TwitterService('v1', tokens);
});

// nock is not working, skip the test.
xdescribe('TwitterService', () => {
  describe('tweet', () => {
    it('should post a tweet using v1 API', async () => {
      const tweetText = 'Test tweet';

      const scope = nock('https://api.twitter.com')
        .post('/1.1/statuses/update.json')
        .reply(200, { id_str: 'testTweetId' });

      const tweetId = await twitterService.tweet(tweetText);

      scope.done();

      expect(tweetId).toEqual('testTweetId');
    });

    it('should post a tweet using v2 API', async () => {
      const tweetText = 'Test tweet';

      const scope = nock('https://api.twitter.com/2')
        .post('/tweets')
        .reply(200, { data: { id: 'testTweetId' } });

      twitterService = new TwitterService('v2', tokens);

      const tweetId = await twitterService.tweet(tweetText);

      scope.done();

      expect(tweetId).toEqual('testTweetId');
    });
  });

  describe('uploadMedia', () => {
    it('should upload media and return media ID', async () => {
      const mediaBuffer: Buffer = Buffer.from('test');

      const scope = nock('https://upload.twitter.com/1.1')
        .post('/media/upload.json')
        .reply(200, { media_id_string: 'testMediaId' });

      const mediaId = await twitterService.uploadMedia(mediaBuffer, 'image/png');

      scope.done();

      expect(mediaId).toEqual('testMediaId');
    });
  });
});
