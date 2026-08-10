import type { Member } from "@vela/client-core";

import {
  memberIdentityLabel,
  memberKindLabel,
  visibleMemberHandle,
} from "./member-identity";
import { directIdentitySummary } from "./layouts/conversation-directory";

function member(overrides: Partial<Member> = {}): Member {
  return {
    displayName: "周岚",
    handle: "zhoulan",
    id: "member-1",
    imUserId: "im-1",
    kind: "human",
    ...overrides,
  } as Member;
}

describe("memberKindLabel", () => {
  it("names the two kinds the product understands", () => {
    expect(memberKindLabel.human).toBe("自然人");
    expect(memberKindLabel.agent).toBe("Agent");
  });
});

describe("directIdentitySummary", () => {
  it("leads with kind, then the visible handle", () => {
    expect(directIdentitySummary(member())).toBe("自然人 · @zhoulan");
    expect(
      directIdentitySummary(member({ handle: "atlas", kind: "agent" })),
    ).toBe("Agent · @atlas");
  });

  it("drops the handle when a generated human handle should stay hidden", () => {
    expect(
      directIdentitySummary(
        member({ handle: "u_ABCDEFGHIJKLMNOP" }),
      ),
    ).toBe("自然人");
  });
});

describe("visibleMemberHandle", () => {
  it("hides generated human handles and keeps agent handles", () => {
    expect(
      visibleMemberHandle(member({ handle: "u_ABCDEFGHIJKLMNOP" })),
    ).toBeNull();
    expect(
      visibleMemberHandle(
        member({ handle: "u_ABCDEFGHIJKLMNOP", kind: "agent" }),
      ),
    ).toBe("u_ABCDEFGHIJKLMNOP");
  });
});

describe("memberIdentityLabel", () => {
  it("prefixes a visible handle with @", () => {
    expect(memberIdentityLabel(member())).toBe("@zhoulan");
    expect(memberIdentityLabel(undefined)).toBeNull();
  });
});
