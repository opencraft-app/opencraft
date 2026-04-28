import json

p = "src/i18n/generated/en-US.json"
d = json.load(open(p))
tr = {
  "k_08520169": "The ID card number format is invalid. Please check and try again.",
  "k_0a7d6e9a": "Confirm deletion",
  "k_0fb7f587": "Name and ID card number do not match. Please re-enter.",
  "k_18f8d17d": "The real name format is invalid. Please check and try again.",
  "k_18fb924f": "Continue as guest",
  "k_1d169841": "Sign in / Sign up",
  "k_2d9fe2b8": "Once deleted, subscriptions, orders and agent data will be permanently erased and cannot be recovered. Are you sure you want to delete this account?",
  "k_2fb90b05": "Processing...",
  "k_32299f0c": "After signing in, you can view and manage your profile, subscription plan and order history.",
  "k_32ffa250": "ID card number",
  "k_3348b714": "Please enter your real name",
  "k_4298a6d6": "Currently active",
  "k_454fd8cd": "Please enter your ID card number",
  "k_4c9c0956": "The verification service is busy or unavailable. Please try again later.",
  "k_4d5ccd01": "Expired",
  "k_5142d15d": "ID type",
  "k_5197d03d": "Real-name verification",
  "k_53cab44e": "Account info",
  "k_5439255d": "Submit verification",
  "k_5dfef901": "Uploading avatar...",
  "k_5f944660": "Click to change avatar",
  "k_609a8b7a": "Restoring session...",
  "k_60b7b9dd": "Real-name verification failed. Please try again later.",
  "k_625fb26b": "Cancel",
  "k_6a6a00d6": "Guest sign-in failed. Please try again later.",
  "k_6d4e0e36": "Verify now",
  "k_6da2cf8c": "Entering...",
  "k_6db9dec2": "Network error. Please try again later.",
  "k_6e776cd3": "Sign in to view account info",
  "k_6eaa1495": "Verified",
  "k_7362b32a": "Subscription plan",
  "k_7eacb4d9": "Real name",
  "k_8eb15974": "Create your dedicated cloud Hermes in an instant",
  "k_920f199a": "Subscription period",
  "k_97e81c8b": "Complete real-name verification to publish skills and join more community activities",
  "k_a39d4a09": "Your name and ID card number are encrypted in transit and at rest. The platform only keeps masked info for display. Verification data is never used for other purposes.",
  "k_a7570043": "{days} days left",
  "k_ab975481": "Real-name verification failed. Please try again later.",
  "k_abe2c5d2": "Submitting...",
  "k_ac5a3643": "Not verified yet. Please complete your info and submit for verification.",
  "k_afd8c670": "Credits used",
  "k_c3992269": "Sign out",
  "k_ce717abb": "Current plan",
  "k_d625238c": "Real-name verification service is unavailable. Please try again later.",
  "k_d9913a32": "Failed to upload avatar. Please try again later.",
  "k_dc4394f2": "Manage your personal account info and settings",
  "k_dd41d596": "No subscription yet",
  "k_ec41af83": "Delete account",
  "k_f33656e1": "ID card",
  "k_fe2d26a2": "Not set",
}
for k, v in tr.items():
    d[k] = v
sorted_d = {k: d[k] for k in sorted(d)}
with open(p, 'w') as f:
    json.dump(sorted_d, f, ensure_ascii=False, indent=2)
    f.write('\n')
missing = sum(1 for v in d.values() if not v)
print('missing', missing)
