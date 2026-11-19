
CREATE TABLE gateway_limits(actor TEXT PRIMARY KEY, monthly_tokens INTEGER NOT NULL CHECK(monthly_tokens>=0), request_tokens INTEGER NOT NULL CHECK(request_tokens>0), concurrency INTEGER NOT NULL CHECK(concurrency>0), revision INTEGER NOT NULL) STRICT;
CREATE TABLE gateway_sponsors(thread TEXT PRIMARY KEY, actor TEXT NOT NULL, parent TEXT, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE gateway_requests(id TEXT PRIMARY KEY, actor TEXT NOT NULL, thread TEXT NOT NULL, model TEXT NOT NULL, credential TEXT, period TEXT NOT NULL, reserved INTEGER NOT NULL CHECK(reserved>0), actual INTEGER CHECK(actual>=0), state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','settled','released','unknown')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE INDEX gateway_requests_actor ON gateway_requests(actor,period,state);
CREATE TABLE gateway_contributions(provider TEXT PRIMARY KEY, actor TEXT NOT NULL, template_provider TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('preparing','shared','withdrawn')), created_at INTEGER NOT NULL) STRICT;
CREATE TABLE gateway_audit(id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
