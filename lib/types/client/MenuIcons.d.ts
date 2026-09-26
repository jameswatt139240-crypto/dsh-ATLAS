import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { MenuState } from '@deepseek-ai/dsh-client-ui-input-trigger/client';
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
/** The attribute this overlay sets on an icon slot it covers. */
export declare const HOST_ATTRIBUTE = "data-dsh-atlas-menu-icon-host";
/** What the session's overlay shares with the menu layer. */
export interface MenuIconsInjected {
    /** The trigger controller's menu store: the rows, their order, and the open state. */
    readonly hooks: {
        readonly menu: SnapshotStore<MenuState>;
    };
}
/** Overlay entry props: the composer runtime face plus the menu store. */
export type MenuIconsProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<MenuIconsInjected>;
/** The glyph layer. */
export declare function MenuIcons({ useMenu }: MenuIconsProps): import("react").JSX.Element | null;
