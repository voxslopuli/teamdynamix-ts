import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTeamDynamixClient } from '../src/client/index.js';
import { TeamDynamixClientError } from '../src/client/errors.js';
import { server, specPath } from './setup-msw.js';

const REAL_SPEC = `${process.cwd()}/src/generated/openapi.json`;

describe('runtime schema validation against the real deployment spec (#22)', () => {
  it('compiles and validates the ticket feed route without throwing on duplicate enums', async () => {
    server.use(
      http.get('https://api.teamdynamix.com/api/1/tickets/9001/feed', () =>
        HttpResponse.json(
          [
            {
              ID: 1,
              ItemType: 25, // FeedItemType duplicate member (Ticket Task / Maintenance Activity)
              Body: 'entry body',
              CreatedUid: 'uid-1',
              RepliesCount: 0,
            },
          ],
          { status: 200 },
        ),
      ),
    );

    const { client } = await createTeamDynamixClient({
      tenant: 'api',
      tokenProvider: () => 'token',
      specPath: REAL_SPEC,
      // default mode (fail-closed) — matches what consumers get by default
    });

    const feed = await client.tickets.appIdTicketsIdFeed({ params: { path: { appId: 1, id: 9001 } } });
    expect(feed).toBeTruthy();
  });

  it('searches tickets through a path-prefixed base URL (validation off)', async () => {
    server.use(
      http.post('https://api.teamdynamix.com/TDWebApi/api/7/tickets/search', () =>
        HttpResponse.json(
          [
            { ID: 42, Title: 'VPN down' },
            { ID: 43, Title: 'Email down' },
          ],
          { status: 200 },
        ),
      ),
    );

    const { client } = await createTeamDynamixClient({
      tenant: 'api',
      tokenProvider: () => 'token',
      specPath: REAL_SPEC,
      baseUrl: 'https://api.teamdynamix.com/TDWebApi',
      runtimeValidationMode: 'fail-open',
    });

    const tickets = (await client.tickets.appIdTicketsSearch({ params: { path: { appId: 7 } }, body: {} })) as unknown;
    expect(tickets).toEqual([
      { ID: 42, Title: 'VPN down' },
      { ID: 43, Title: 'Email down' },
    ]);
  });

  it('documented semantics: fail-closed rejects live responses that do not match the published doc (#22 symptom 2)', async () => {
    // The live API's own responses do not satisfy its published Ticket schema
    // (required-field drift). Under the explicit fail-closed contract this is
    // an error, not empty data; consumers that trust their own boundary validation
    // (this SDK's MCP server) opt into fail-open. Compile errors, by contrast,
    // can no longer fail-closed anything: schemas that do not compile are
    // skipped (warned once) rather than throwing per call.
    server.use(
      http.post('https://api.teamdynamix.com/TDWebApi/api/7/tickets/search', () =>
        HttpResponse.json([{ ID: 42, Title: 'VPN down' }], { status: 200 }),
      ),
    );

    const { client } = await createTeamDynamixClient({
      tenant: 'api',
      tokenProvider: () => 'token',
      specPath: REAL_SPEC,
      baseUrl: 'https://api.teamdynamix.com/TDWebApi',
      runtimeValidationMode: 'fail-closed',
    });

    await expect(
      client.tickets.appIdTicketsSearch({ params: { path: { appId: 7 } }, body: {} }),
    ).rejects.toBeInstanceOf(TeamDynamixClientError);
  });
});
