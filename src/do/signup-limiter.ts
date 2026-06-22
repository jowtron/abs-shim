// Per-IP signup throttle.
//
// POST /api/signup/register is public (no requireAuth) so it's reachable by
// anyone on the internet. An in-memory counter in the Worker isolate is
// useless here — each request can land on a fresh isolate with its own memory,
// so the count never accumulates. A Durable Object addressed by client IP
// (idFromName(ip)) gives one consistent, strongly-serialized counter per IP.
//
// The Worker POSTs { limit, windowMs }; the DO keeps a fixed-window counter and
// answers { allowed, retryAfter }. Idle per-IP DOs just hibernate at ~no cost.
export class SignupRateLimitDO {
  constructor(private state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const { limit, windowMs } = (await req.json()) as { limit: number; windowMs: number };
    const now = Date.now();
    const rec = (await this.state.storage.get<{ count: number; windowStart: number }>('rec'))
      ?? { count: 0, windowStart: now };
    // Fixed window: reset once the window elapses.
    if (now - rec.windowStart > windowMs) {
      rec.count = 0;
      rec.windowStart = now;
    }
    rec.count += 1;
    await this.state.storage.put('rec', rec);
    const allowed = rec.count <= limit;
    const retryAfter = allowed ? 0 : Math.ceil((rec.windowStart + windowMs - now) / 1000);
    return Response.json({ allowed, retryAfter });
  }
}
