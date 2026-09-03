import i18n from "i18next";
import { setI18n } from "react-i18next";

/*
 * Public-shell components read react-i18next state before a locale-specific
 * page loads the full dictionaries. Register the shared instance without
 * importing those dictionaries. Early shell consumers opt out of Suspense at
 * their own hook boundary so the global react-i18next defaults stay intact.
 */
setI18n(i18n);
