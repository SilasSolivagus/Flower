'use client';

import { NO_PERMISSION_MESSAGE, NoAccess } from '@/components/no-access';

/** 没有对应页面的设置地址：中文无权说明，不用英文 404。 */
export default function UnknownSettingsPage() {
  return <NoAccess message={NO_PERMISSION_MESSAGE} />;
}
