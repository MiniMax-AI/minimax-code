import {
  TuiThemePicker,
  type TuiThemeAppearanceChoice,
} from '../../features/settings/theme-picker.js';
import type { TuiInteractionSurface } from '../../shell/interaction-surface.js';
import type { TuiThemeController } from '../../theme/controller.js';

/** Persist an appearance pin as `id/light` so the next launch restores it. */
export function themeSettingValue(themeId: string, appearance: TuiThemeAppearanceChoice): string {
  return appearance === 'auto' ? themeId : `${themeId}/${appearance}`;
}

export function showTuiThemeSetup(options: {
  readonly controller: TuiThemeController;
  readonly surface: Pick<TuiInteractionSurface, 'show' | 'close' | 'request'>;
  readonly persist?: (theme: string) => void;
}): void {
  const { controller, surface } = options;
  const picker = new TuiThemePicker({
    themes: controller.listThemes(),
    currentThemeId: controller.selectedThemeId(),
    currentAppearance: controller.snapshot().appearance,
    appearanceOverride: controller.appearanceOverrideValue(),
    preview: (themeId) => {
      controller.previewTheme(themeId);
    },
    setAppearance: (choice) => {
      controller.setAppearanceOverride(choice === 'auto' ? undefined : choice);
    },
    save: (themeId, appearance) => {
      // Commit before persisting so a write failure leaves the previous theme
      // active and the picker can show the error without losing the selection.
      if (!controller.setTheme(themeId)) {
        throw new Error(`Theme "${themeId}" is no longer available`);
      }
      options.persist?.(themeSettingValue(themeId, appearance));
    },
    onClose: () => {
      surface.close(picker);
    },
    requestRender: () => surface.request(),
  });
  surface.show(picker);
}
