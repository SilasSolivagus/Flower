'use client';

import '@blocknote/shadcn/style.css';
import { BlockNoteEditor } from '@blocknote/core';
import { SuggestionMenu } from '@blocknote/core/extensions';
import { zh } from '@blocknote/core/locales';
import { type DefaultReactSuggestionItem, SuggestionMenuController, type SuggestionMenuProps, useComponentsContext, useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { useTheme } from 'next-themes';
import { createContext, type KeyboardEvent, type Ref, type RefObject, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { SUGGESTION_KIND_LABEL } from '@/features/links/model';
import type { LinkSuggestion } from '@/lib/types';
import { type DecorationInput, decorationsKey, flowerDecorations } from './decorations';

export type PrdEditorHandle = { getMarkdown: () => string };
export type PrdEditorProps = {
  initialMarkdown: string;
  editable: boolean;
  onDirty?: () => void;
  uploadImage?: (file: File) => Promise<string>;
  /** 正文里的链接卡等显示数据：变化时推给编辑器重画，不改正文。 */
  decorations?: DecorationInput;
  /** 输入 [[ 时的补全搜索；不传时不启用补全。 */
  searchLinks?: (query: string) => Promise<LinkSuggestion[]>;
  ref?: Ref<PrdEditorHandle>;
};

const TRIGGER = '[[';
const DEBOUNCE_MS = 150;

/** 补全条目：带着它所属的查询，回车时据此判断列表是否已落定到当前输入。 */
type LinkItem = DefaultReactSuggestionItem & { query: string };
/** 补全菜单当前显示的内容：回车由编辑器自己的按键处理按它选条目。 */
type MenuShown = Pick<SuggestionMenuProps<LinkItem>, 'items' | 'selectedIndex' | 'onItemClick'>;
const MenuShownContext = createContext<RefObject<MenuShown | null> | null>(null);

/** [[ 补全菜单：显示方式与 BlockNote 默认菜单相同，另把显示中的条目与选中项记下来。 */
function LinkSuggestionMenu({ items, loadingState, selectedIndex, onItemClick }: SuggestionMenuProps<LinkItem>) {
  const Components = useComponentsContext()!;
  const shownRef = useContext(MenuShownContext);
  // layout 阶段记录：与屏幕上的列表同步更新，按键处理读到的就是用户看到的条目
  useLayoutEffect(() => {
    if (!shownRef) return;
    shownRef.current = { items, selectedIndex, onItemClick };
    return () => {
      shownRef.current = null;
    };
  });
  return (
    <Components.SuggestionMenu.Root id="bn-suggestion-menu" className="bn-suggestion-menu">
      {items.flatMap((item, i) => [
        ...(item.group !== items[i - 1]?.group
          ? [
              <Components.SuggestionMenu.Label key={`group:${item.group}`} className="bn-suggestion-menu-label">
                {item.group}
              </Components.SuggestionMenu.Label>,
            ]
          : []),
        <Components.SuggestionMenu.Item
          key={item.title}
          id={`bn-suggestion-menu-item-${i}`}
          className="bn-suggestion-menu-item"
          item={item}
          isSelected={i === selectedIndex}
          onClick={() => onItemClick?.(item)}
        />,
      ])}
      {items.length === 0 && loadingState !== 'loading-initial' && <Components.SuggestionMenu.EmptyItem className="bn-suggestion-menu-item">无匹配项</Components.SuggestionMenu.EmptyItem>}
      {loadingState !== 'loaded' && <Components.SuggestionMenu.Loader className="bn-suggestion-menu-loader" />}
    </Components.SuggestionMenu.Root>
  );
}

/** Markdown → 块：用一个不挂载的编辑器实例解析，只在首次渲染时调用。空正文返回 undefined（BlockNote 要求初始内容非空）。 */
function parseMarkdown(markdown: string) {
  if (!markdown.trim()) return undefined;
  const blocks = BlockNoteEditor.create().tryParseMarkdownToBlocks(markdown);
  return blocks.length > 0 ? blocks : undefined;
}

/**
 * 一篇 PRD 正文的 BlockNote 编辑器。Markdown 是唯一数据源：挂载时解析一次，之后由父组件
 * 通过 ref 的 getMarkdown() 在需要保存时序列化；正文被外部替换（冲突后重新加载、恢复版本）时由父组件换 key 重新挂载。
 * [[ ]] 在正文里是普通文字，链接卡由装饰插件显示。
 */
export function PrdEditor({ initialMarkdown, editable, onDirty, uploadImage, decorations, searchLinks, ref }: PrdEditorProps) {
  const [initialContent] = useState(() => parseMarkdown(initialMarkdown));
  const [extensions] = useState(() => [flowerDecorations()]);
  const editor = useCreateBlockNote({ initialContent, dictionary: zh, uploadFile: uploadImage, extensions });
  useImperativeHandle(ref, () => ({ getMarkdown: () => editor.blocksToMarkdownLossy(editor.document) }), [editor]);
  // 只带元数据的事务：不改文档，不触发 onChange，因此不会引起自动保存
  useEffect(() => {
    if (!decorations) return;
    editor.transact((tr) => {
      tr.setMeta(decorationsKey, decorations);
    });
  }, [editor, decorations]);

  // 每次查询变化 BlockNote 都会调用 getItems；查询 150ms 内又变了的不发请求（它的结果 BlockNote 也会丢弃）
  const latestCall = useRef(0);
  const getItems = useCallback(
    async (query: string): Promise<LinkItem[]> => {
      if (!searchLinks) return [];
      const call = ++latestCall.current;
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS));
      if (call !== latestCall.current) return [];
      const list = await searchLinks(query).catch(() => []);
      return list.map((s) => ({
        query,
        title: `${s.displayKey} ${s.title}`.trim(),
        subtext: s.hint ?? undefined,
        group: SUGGESTION_KIND_LABEL[s.kind],
        onItemClick: () => {
          if (s.next === 'sections') {
            // 选中 PRD：重新打开补全并写入「编号#」，接着列出它的小节
            editor.getExtension(SuggestionMenu)?.openSuggestionMenu(TRIGGER, { deleteTriggerCharacter: true });
            editor.insertInlineContent(`${s.insert}#`, { updateSelection: true });
          } else {
            editor.insertInlineContent(`[[${s.insert}]]`, { updateSelection: true });
          }
        },
      }));
    },
    [editor, searchLinks],
  );

  // [[ 补全菜单打开时的回车由这里处理，拦在 BlockNote 自己的菜单按键处理（挂在内层编辑区的捕获阶段）之前：
  // BlockNote 在新查询的结果返回前仍用上一次查询的条目响应回车，且不识别 Safari 确认组字时的回车。
  const menuShown = useRef<MenuShown | null>(null);
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return;
    const menu = editor.getExtension(SuggestionMenu)?.store.state;
    if (!menu?.show || menu.triggerCharacter !== TRIGGER) return;
    e.stopPropagation();
    // 输入法组字时的回车用于上屏，不选条目；Safari 确认组字时 isComposing 已为 false，但 keyCode 仍是 229
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    const shown = menuShown.current;
    const item = shown && shown.selectedIndex !== undefined ? shown.items[shown.selectedIndex] : undefined;
    // 列表还没落定到当前输入（防抖未到或请求在途，显示的是上一次查询的结果）时，回车不采用
    if (item && item.query === menu.query) shown?.onItemClick?.(item);
  };

  const { resolvedTheme } = useTheme();
  return (
    <BlockNoteView editor={editor} editable={editable} onChange={() => onDirty?.()} theme={resolvedTheme === 'dark' ? 'dark' : 'light'} onKeyDownCapture={onKeyDownCapture}>
      {editable && searchLinks && (
        <MenuShownContext value={menuShown}>
          <SuggestionMenuController triggerCharacter={TRIGGER} getItems={getItems} suggestionMenuComponent={LinkSuggestionMenu} />
        </MenuShownContext>
      )}
    </BlockNoteView>
  );
}
