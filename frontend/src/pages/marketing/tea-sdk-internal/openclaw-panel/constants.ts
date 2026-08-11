import i18n from "@/i18n";
import { IS_I18N } from '../config/constants';

const getI18nTutorialUrl = () => {
  if (i18n.language?.startsWith('en')) return 'https://www.tencentcloud.com/techpedia/139189';
  return 'https://www.tencentcloud.com/techpedia/139678';
};

export const TUTORIAL_URL = IS_I18N ? getI18nTutorialUrl() : 'https://cloud.tencent.com/developer/article/2624973';
