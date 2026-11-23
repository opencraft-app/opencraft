// Empty worker for scripts/cloudflare/rehearsal-leftovers.ts: the rehearsal
// access guard wrapped around it answers the authenticated purge request that
// empties leftover R2 buckets before they are deleted; anything else is 404.
export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
};
