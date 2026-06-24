# vela-backends/tests/fixtures

Raw provider protocol samples and recorded agent cassettes live here.

These fixtures are external facts copied or adapted from provider behavior and Paseo/Synara-style runtime samples. Keep dynamic IDs deterministic and small.

`cassettes/` stores sanitized record-once/replay-many fixtures. Creating or refreshing a cassette may use a real provider token, but replay tests must not require a token, network, or live model.
