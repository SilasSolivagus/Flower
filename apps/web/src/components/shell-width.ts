/** 组织壳主区宽度。宽表页不设上限；阅读页保持 1280 居中。 */

const READING_SECTION = 'documents';

const WIDE_MAIN = 'flex w-full flex-1 flex-col gap-5 px-4 py-6 md:px-8';
const READING_MAIN = 'mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-5 px-4 py-6 md:px-8';

/** 路径第二段是文档时走阅读宽度。工作台只有组织段，以及其余路由，都走宽表。 */
export function shellMainClassName(pathname: string): string {
  const section = pathname.split('/').filter(Boolean)[1];
  return section === READING_SECTION ? READING_MAIN : WIDE_MAIN;
}
