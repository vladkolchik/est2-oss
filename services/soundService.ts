import { Howl } from 'howler';

type SfxName = 'ui_click' | 'ui_toggle' | 'action_confirm' | 'action_error' | 'ui_menu_focus' | 'ui_menu_ok';

const UI_VOLUME_DEFAULT = (() => { try { return Number(localStorage.getItem('ui-volume') || '0.8'); } catch { return 0.8; } })();
const ACTION_VOLUME_DEFAULT = (() => { try { return Number(localStorage.getItem('ambient-volume') || '0.6'); } catch { return 0.6; } })();

const SFX_SOURCES: Record<SfxName, string[]> = {
    ui_click: [
        // lightweight blip; replace with your actual asset path(s)
        '/audio/ui_click.mp3'
    ],
    ui_toggle: ['/audio/ui_toggle.mp3'],
    action_confirm: ['/audio/action_confirm.mp3'],
    action_error: ['/audio/action_error.mp3'],
    ui_menu_focus: ['/audio/ui_menu_focus.wav', '/audio/ui_menu_focus.mp3'],
    ui_menu_ok: ['/audio/ui_menu_ok.wav', '/audio/ui_menu_ok.mp3']
};

class SoundService {
    private uiVolume = UI_VOLUME_DEFAULT;
    private actionVolume = ACTION_VOLUME_DEFAULT;

    constructor() {
        // Listen for external volume changes
        window.addEventListener('ui-volume-change', (e: Event) => {
            const v = (e as CustomEvent).detail?.volume;
            if (typeof v === 'number') this.setUiVolume(v);
        });
        window.addEventListener('action-volume-change', (e: Event) => {
            const v = (e as CustomEvent).detail?.volume;
            if (typeof v === 'number') this.setActionVolume(v);
        });
    }

    setUiVolume(volume: number) {
        const v = Math.max(0, Math.min(1, Number(volume)));
        this.uiVolume = v;
        try { localStorage.setItem('ui-volume', String(v)); } catch {}
    }

    getUiVolume(): number { return this.uiVolume; }

    setActionVolume(volume: number) {
        const v = Math.max(0, Math.min(1, Number(volume)));
        this.actionVolume = v;
        try { localStorage.setItem('ambient-volume', String(v)); } catch {}
    }

    getActionVolume(): number { return this.actionVolume; }

    playUi(name: Extract<SfxName, 'ui_click' | 'ui_toggle' | 'ui_menu_focus' | 'ui_menu_ok'>) {
        const src = SFX_SOURCES[name];
        if (!src) return;
        new Howl({ src, volume: this.uiVolume, html5: false }).play();
    }

    playAction(name: Extract<SfxName, 'action_confirm' | 'action_error'>) {
        const src = SFX_SOURCES[name];
        if (!src) return;
        new Howl({ src, volume: this.actionVolume, html5: false }).play();
    }
}

export const soundService = new SoundService();
export default soundService;


