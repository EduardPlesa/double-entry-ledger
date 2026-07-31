import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROBLEM_CONTENT_TYPE } from '../../src/http/problem.js';
import {
  START,
  STRONG_PASSWORD,
  asCookie,
  createTestApplication,
  refreshCookieHeader,
  refreshCookieValue,
  uniqueEmail,
  type TestApplication,
} from '../helpers/app.js';

/**
 * The auth endpoints against the real application and a real Postgres.
 *
 * Through HTTP rather than by calling the service, because half of what matters here is
 * transport: which token goes in the body, which goes in a cookie, what attributes that
 * cookie carries, and what a failure looks like on the wire.
 */

let application: TestApplication;

beforeAll(() => {
  application = createTestApplication();
});

afterAll(async () => {
  application.clock.set(START);
  await application.close();
});

const api = () => request(application.app);

/** Registers a fresh user and returns the response. */
async function registerUser(email = uniqueEmail()) {
  const response = await api().post('/auth/register').send({ email, password: STRONG_PASSWORD });
  return { email, response };
}

describe('POST /auth/register', () => {
  it('creates the account, returns an access token in the body and a refresh cookie', async () => {
    const { email, response } = await registerUser();

    expect(response.status).toBe(201);
    expect(response.body.user.email).toBe(email);
    expect(response.body.tokenType).toBe('Bearer');
    expect(response.body.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);

    // The refresh token is never in the body. That split is the entire point of having two
    // tokens: the long-lived one lives where script cannot read it.
    expect(JSON.stringify(response.body)).not.toContain(refreshCookieValue(response));
  });

  it('never returns the password hash, or anything else about the row', async () => {
    const { response } = await registerUser();

    expect(response.body.user).toEqual({ id: expect.any(String), email: expect.any(String) });
  });

  it('normalises the email, so case cannot create a second account', async () => {
    const email = uniqueEmail();

    const first = await api().post('/auth/register').send({ email, password: STRONG_PASSWORD });
    const second = await api()
      .post('/auth/register')
      .send({ email: email.toUpperCase(), password: STRONG_PASSWORD });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('rejects a password too short to be worth hashing', async () => {
    const response = await api()
      .post('/auth/register')
      .send({ email: uniqueEmail(), password: 'short' });

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(response.body.errors).toContainEqual({
      path: 'password',
      message: 'must be at least 12 characters',
    });
  });

  it('rejects a body that is not credentials at all', async () => {
    const response = await api().post('/auth/register').send({ email: 'not-an-email' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('the refresh cookie', () => {
  it('is httpOnly, secure, lax and scoped to /auth', async () => {
    const { response } = await registerUser();
    const cookie = refreshCookieHeader(response);

    expect(cookie).toBeDefined();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');

    // Scoped, so the ordinary API surface never receives a credential it has no use for.
    expect(cookie).toContain('Path=/auth');
  });
});

describe('POST /auth/login', () => {
  it('exchanges correct credentials for a session', async () => {
    const { email } = await registerUser();

    const response = await api().post('/auth/login').send({ email, password: STRONG_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(refreshCookieHeader(response)).toBeDefined();
  });

  it('answers a wrong password and an unknown email identically', async () => {
    // Anything that told these apart would turn the login endpoint into a way to ask whether
    // a given person has an account here, which is often the more sensitive question.
    const { email } = await registerUser();

    const wrongPassword = await api()
      .post('/auth/login')
      .send({ email, password: 'definitely-not-the-password' });
    const unknownEmail = await api()
      .post('/auth/login')
      .send({ email: uniqueEmail(), password: STRONG_PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.code).toBe(unknownEmail.body.code);
    expect(wrongPassword.body.detail).toBe(unknownEmail.body.detail);
    expect(wrongPassword.body.title).toBe(unknownEmail.body.title);
  });

  it('sets no cookie when it refuses', async () => {
    const response = await api()
      .post('/auth/login')
      .send({ email: uniqueEmail(), password: STRONG_PASSWORD });

    expect(refreshCookieHeader(response)).toBeUndefined();
  });
});

describe('POST /auth/refresh', () => {
  it('rotates: a new refresh token, and a new access token', async () => {
    const { response: registered } = await registerUser();
    const original = refreshCookieValue(registered);

    const refreshed = await api().post('/auth/refresh').set('Cookie', asCookie(original));

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toEqual(expect.any(String));
    expect(refreshCookieValue(refreshed)).not.toBe(original);
  });

  it('refuses the token it just replaced', async () => {
    const { response: registered } = await registerUser();
    const original = refreshCookieValue(registered);

    await api().post('/auth/refresh').set('Cookie', asCookie(original));
    const replayed = await api().post('/auth/refresh').set('Cookie', asCookie(original));

    expect(replayed.status).toBe(401);
    expect(replayed.body.code).toBe('UNAUTHENTICATED');
  });

  it('lets a rotated session keep going, one token after another', async () => {
    const { response: registered } = await registerUser();

    let current = refreshCookieValue(registered);
    for (let round = 0; round < 3; round += 1) {
      const response = await api().post('/auth/refresh').set('Cookie', asCookie(current));
      expect(response.status).toBe(200);
      current = refreshCookieValue(response);
    }
  });

  it('refuses when no cookie is presented at all', async () => {
    const response = await api().post('/auth/refresh');

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a token that was never issued', async () => {
    const response = await api().post('/auth/refresh').set('Cookie', asCookie('not-a-real-token'));

    expect(response.status).toBe(401);
  });

  it('clears the dead cookie when it refuses', async () => {
    // Otherwise the browser keeps presenting a credential that can never work again, and
    // every subsequent failure looks like a fresh incident.
    const { response: registered } = await registerUser();
    const original = refreshCookieValue(registered);

    await api().post('/auth/refresh').set('Cookie', asCookie(original));
    const replayed = await api().post('/auth/refresh').set('Cookie', asCookie(original));

    expect(refreshCookieHeader(replayed)).toContain('Expires=Thu, 01 Jan 1970');
  });

  it('refuses a token whose lifetime has run out', async () => {
    const { response: registered } = await registerUser();
    const token = refreshCookieValue(registered);

    application.clock.set(new Date(START.getTime() + 31 * 24 * 60 * 60 * 1000));
    const response = await api().post('/auth/refresh').set('Cookie', asCookie(token));
    application.clock.set(START);

    expect(response.status).toBe(401);
  });
});

describe('reuse detection', () => {
  it('revokes the whole family when a spent token comes back', async () => {
    // The scenario: a token is stolen, the legitimate holder rotates first, and the thief
    // then presents the copy they took. From the server's side this is indistinguishable
    // from the reverse - so the only safe answer is to end the session for both parties.
    const { response: registered } = await registerUser();
    const stolen = refreshCookieValue(registered);

    const rotated = await api().post('/auth/refresh').set('Cookie', asCookie(stolen));
    const live = refreshCookieValue(rotated);

    // The thief tries the copy they took.
    const reused = await api().post('/auth/refresh').set('Cookie', asCookie(stolen));
    expect(reused.status).toBe(401);

    // And the legitimate holder's current token is dead too. That is the cost of the policy,
    // and it is the right way round: a false positive costs one login, a false negative
    // costs the account.
    const afterwards = await api().post('/auth/refresh').set('Cookie', asCookie(live));
    expect(afterwards.status).toBe(401);
  });

  it('kills the whole chain, not just the two tokens involved', async () => {
    const { response: registered } = await registerUser();

    let current = refreshCookieValue(registered);
    const chain = [current];
    for (let round = 0; round < 3; round += 1) {
      const response = await api().post('/auth/refresh').set('Cookie', asCookie(current));
      current = refreshCookieValue(response);
      chain.push(current);
    }

    // Present the very first token, four rotations later.
    const reused = await api().post('/auth/refresh').set('Cookie', asCookie(chain[0] ?? ''));
    expect(reused.status).toBe(401);

    for (const token of chain) {
      const response = await api().post('/auth/refresh').set('Cookie', asCookie(token));
      expect(response.status).toBe(401);
    }
  });

  it('leaves one family alone when another is revoked', async () => {
    // Two logins are two families. An incident on one device must not sign the user out
    // everywhere, or the mechanism becomes something operators disable.
    const { email } = await registerUser();

    const deviceA = await api().post('/auth/login').send({ email, password: STRONG_PASSWORD });
    const deviceB = await api().post('/auth/login').send({ email, password: STRONG_PASSWORD });

    const stolenFromA = refreshCookieValue(deviceA);
    await api().post('/auth/refresh').set('Cookie', asCookie(stolenFromA));
    await api().post('/auth/refresh').set('Cookie', asCookie(stolenFromA));

    const stillGood = await api()
      .post('/auth/refresh')
      .set('Cookie', asCookie(refreshCookieValue(deviceB)));

    expect(stillGood.status).toBe(200);
  });

  it('treats two simultaneous refreshes as reuse, deterministically', async () => {
    // The compare-and-swap means exactly one of these can win. The loser looks like a replay,
    // because from here it is one - and the alternative, letting both succeed, is the race
    // this whole mechanism exists to detect.
    const { response: registered } = await registerUser();
    const token = refreshCookieValue(registered);

    const [first, second] = await Promise.all([
      api().post('/auth/refresh').set('Cookie', asCookie(token)),
      api().post('/auth/refresh').set('Cookie', asCookie(token)),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 401]);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const { response: registered } = await registerUser();
    const token = refreshCookieValue(registered);

    const loggedOut = await api().post('/auth/logout').set('Cookie', asCookie(token));

    expect(loggedOut.status).toBe(204);
    expect(refreshCookieHeader(loggedOut)).toContain('Expires=Thu, 01 Jan 1970');

    const afterwards = await api().post('/auth/refresh').set('Cookie', asCookie(token));
    expect(afterwards.status).toBe(401);
  });

  it('succeeds with no cookie, and with a cookie nobody issued', async () => {
    // The caller asked to be logged out and they are. An endpoint that refused to do the safe
    // thing because the client was already in the safe state would be a strange endpoint.
    expect((await api().post('/auth/logout')).status).toBe(204);
    expect((await api().post('/auth/logout').set('Cookie', asCookie('nonsense'))).status).toBe(204);
  });

  it('does not revoke a family it was not given', async () => {
    const { email } = await registerUser();
    const deviceA = await api().post('/auth/login').send({ email, password: STRONG_PASSWORD });
    const deviceB = await api().post('/auth/login').send({ email, password: STRONG_PASSWORD });

    await api().post('/auth/logout').set('Cookie', asCookie(refreshCookieValue(deviceA)));

    const stillGood = await api()
      .post('/auth/refresh')
      .set('Cookie', asCookie(refreshCookieValue(deviceB)));

    expect(stillGood.status).toBe(200);
  });
});

describe('GET /health', () => {
  it('answers without touching the database', async () => {
    const response = await api().get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
