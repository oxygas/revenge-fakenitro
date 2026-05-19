import { logger } from "@vendetta";
import { storage } from "@vendetta/plugin";
import { findByProps, findByName } from "@vendetta/metro";
import { before, after, instead, unpatchAll } from "@vendetta/patcher";
import { Forms, General, Switch, Slider } from "@vendetta/ui/components";
import { showConfirmationAlert, showToast } from "@vendetta/ui/alerts";

const { Text } = General;
const { FormText, FormSection, FormDivider } = Forms;

// Storage interface
interface PluginStorage {
    enableEmojiBypass: boolean;
    emojiSize: number;
    transformEmojis: boolean;
    enableStickerBypass: boolean;
    stickerSize: number;
    transformStickers: boolean;
    transformCompoundSentence: boolean;
    enableStreamQualityBypass: boolean;
    enableThemes: boolean;
    enableSoundboardBypass: boolean;
    useHyperLinks: boolean;
    hyperLinkText: string;
    disableEmbedPermissionCheck: boolean;
}

// Initialize defaults
const s = storage as PluginStorage;
s.enableEmojiBypass ??= true;
s.emojiSize ??= 48;
s.transformEmojis ??= true;
s.enableStickerBypass ??= true;
s.stickerSize ??= 160;
s.transformStickers ??= true;
s.transformCompoundSentence ??= false;
s.enableStreamQualityBypass ??= true;
s.enableThemes ??= true;
s.enableSoundboardBypass ??= true;
s.useHyperLinks ??= true;
s.hyperLinkText ??= "{{NAME}}";
s.disableEmbedPermissionCheck ??= false;

// Regex patterns
const fakeNitroEmojiRegex = /\/emojis\/(\d+?)\.(png|webp|gif)/;
const fakeNitroStickerRegex = /\/stickers\/(\d+?)\./;
const fakeNitroGifStickerRegex = /\/attachments\/\d+?\/\d+?\/(\d+?)\.gif/;
const hyperLinkRegex = /\[.+?\]\((https?:\/\/.+?)\)/;
const customEmojiRegex = /<(a)?:(\w+):(\d+)>/g;

// Unpatches array
const unpatches: Function[] = [];

// Discord modules (found lazily)
let UserStore: any = null;
let PermissionStore: any = null;
let ChannelStore: any = null;
let EmojiStore: any = null;
let StickersStore: any = null;
let IconUtils: any = null;
let Parser: any = null;
let FluxDispatcher: any = null;
let UploadHandler: any = null;
let GuildMemberStore: any = null;
let SelectedChannelStore: any = null;

function findModules() {
    UserStore = findByProps("getCurrentUser", "getUser");
    PermissionStore = findByProps("can", "canEveryone");
    ChannelStore = findByProps("getChannel", "getChannels");
    EmojiStore = findByProps("getCustomEmojiById", "getCustomEmojiByName");
    StickersStore = findByProps("getStickerById", "getStickers");
    IconUtils = findByProps("getEmojiURL");
    Parser = findByProps("parse", "defaultRules");
    FluxDispatcher = findByProps("dispatch", "subscribe");
    UploadHandler = findByProps("upload", "promptToUpload");
    GuildMemberStore = findByProps("getMember", "getSelfMember");
    SelectedChannelStore = findByProps("getChannelId", "getLastSelectedChannelId");
}

// Permission helpers
function hasPermission(channelId: string, permission: string): boolean {
    const channel = ChannelStore?.getChannel(channelId);
    if (!channel || channel.isPrivate?.()) return true;
    return PermissionStore?.can(permission, channel) ?? true;
}

function hasExternalEmojiPerms(channelId: string): boolean {
    return hasPermission(channelId, "USE_EXTERNAL_EMOJIS");
}

function hasExternalStickerPerms(channelId: string): boolean {
    return hasPermission(channelId, "USE_EXTERNAL_STICKERS");
}

function hasEmbedPerms(channelId: string): boolean {
    return hasPermission(channelId, "EMBED_LINKS");
}

function hasAttachmentPerms(channelId: string): boolean {
    return hasPermission(channelId, "ATTACH_FILES");
}

// Get current channel ID
function getCurrentChannelId(): string | null {
    return SelectedChannelStore?.getChannelId?.() ?? null;
}

// Get current guild
function getCurrentGuild(): any {
    const channelId = getCurrentChannelId();
    if (!channelId) return null;
    const channel = ChannelStore?.getChannel(channelId);
    return channel?.guild_id ? { id: channel.guild_id } : null;
}

// Check if user can use an emoji
function canUseEmote(emoji: any, channelId: string): boolean {
    if (emoji.type === 0) return true; // Unicode emoji
    if (emoji.available === false) return false;

    const user = UserStore?.getCurrentUser();
    const premiumType = user?.premiumType ?? 0;
    const canUseEmotes = premiumType > 0;

    const guildId = emoji.guildId;
    const currentGuildId = getCurrentGuild()?.id;

    if (canUseEmotes) {
        return guildId === currentGuildId || hasExternalEmojiPerms(channelId);
    } else {
        return !emoji.animated && guildId === currentGuildId;
    }
}

// Get word boundary helper
function getWordBoundary(origStr: string, offset: number): string {
    return (!origStr[offset] || /\s/.test(origStr[offset])) ? "" : " ";
}

// Build emoji URL as hyperlink
function buildEmojiLink(emoji: any): string {
    const url = IconUtils?.getEmojiURL({
        id: emoji.id,
        animated: emoji.animated,
        size: s.emojiSize
    });
    if (!url) return emoji.id;

    const fullUrl = new URL(url);
    fullUrl.searchParams.set("size", s.emojiSize.toString());
    fullUrl.searchParams.set("name", emoji.name);
    fullUrl.searchParams.set("lossless", "true");

    const linkText = s.hyperLinkText.replaceAll("{{NAME}}", emoji.name);

    if (s.useHyperLinks) {
        return `[${linkText}](${fullUrl})`;
    }
    return fullUrl.toString();
}

// Build sticker link
function getStickerLink(sticker: any): string {
    const ext = sticker.format_type === 4 ? "gif" : "png"; // APNG = 4, GIF = 2
    return `https://media.discordapp.net/stickers/${sticker.id}.${ext}?size=${s.stickerSize}`;
}

// Patch emoji rendering in messages
function patchEmojiRendering() {
    if (!Parser?.defaultRules) return;

    // Patch the inline code / link rule to transform fake nitro emoji links
    const originalLink = Parser.defaultRules.link;
    if (!originalLink) return;

    const originalReact = originalLink.react;
    if (!originalReact) return;

    Parser.defaultRules.link.react = function (props: any, content: string, options: any) {
        if (s.transformEmojis && props?.href) {
            const match = props.href.match(fakeNitroEmojiRegex);
            if (match) {
                const emojiId = match[1];
                const isAnimated = match[2] === "gif";
                const emojiName = EmojiStore?.getCustomEmojiById(emojiId)?.name ?? "Emoji";

                // Return a custom emoji element
                return Parser.defaultRules.customEmoji?.react?.({
                    jumboable: false,
                    animated: isAnimated,
                    emojiId: emojiId,
                    name: emojiName,
                    fake: true
                }, undefined, options);
            }
        }
        return originalReact.call(this, props, content, options);
    };
}

// Patch sticker rendering
function patchStickerRendering() {
    // Find the sticker rendering module and patch it
    const StickerRenderer = findByProps("renderSticker", "StickerRenderer");
    if (!StickerRenderer) return;

    // Patch to allow all stickers
    if (StickerRenderer.canUseSticker) {
        const orig = StickerRenderer.canUseSticker;
        StickerRenderer.canUseSticker = function (...args: any[]) {
            return true;
        };
    }
}

// Patch premium permission checks
function patchPremiumChecks() {
    // Find the premium utilities module
    const PremiumUtils = findByProps("isPremium", "getUserIsAdmin", "canUseCustomStickersEverywhere");
    if (!PremiumUtils) {
        logger.warn("FakeNitro: Could not find PremiumUtils module");
        return;
    }

    // Patch isPremium to always return true
    if (typeof PremiumUtils.isPremium === "function") {
        const origIsPremium = PremiumUtils.isPremium;
        unpatches.push(
            instead(PremiumUtils, "isPremium", function (this: any, args: any[], orig: Function) {
                // Allow nitro themes and other premium features
                if (s.enableThemes) return true;
                return orig.apply(this, args);
            })
        );
    }

    // Patch canUseCustomStickersEverywhere
    if (typeof PremiumUtils.canUseCustomStickersEverywhere === "function") {
        unpatches.push(
            instead(PremiumUtils, "canUseCustomStickersEverywhere", function (this: any, args: any[], orig: Function) {
                if (s.enableStickerBypass) return true;
                return orig.apply(this, args);
            })
        );
    }

    // Patch canUseHighVideoUploadQuality (stream quality)
    if (typeof PremiumUtils.canUseHighVideoUploadQuality === "function") {
        unpatches.push(
            instead(PremiumUtils, "canUseHighVideoUploadQuality", function (this: any, args: any[], orig: Function) {
                if (s.enableStreamQualityBypass) return true;
                return orig.apply(this, args);
            })
        );
    }

    // Patch canStreamQuality
    if (typeof PremiumUtils.canStreamQuality === "function") {
        unpatches.push(
            instead(PremiumUtils, "canStreamQuality", function (this: any, args: any[], orig: Function) {
                if (s.enableStreamQualityBypass) return true;
                return orig.apply(this, args);
            })
        );
    }

    // Patch canUseClientThemes
    if (typeof PremiumUtils.canUseClientThemes === "function") {
        unpatches.push(
            instead(PremiumUtils, "canUseClientThemes", function (this: any, args: any[], orig: Function) {
                if (s.enableThemes) return true;
                return orig.apply(this, args);
            })
        );
    }

    // Patch canUsePremiumAppIcons
    if (typeof PremiumUtils.canUsePremiumAppIcons === "function") {
        unpatches.push(
            instead(PremiumUtils, "canUsePremiumAppIcons", function (this: any, args: any[], orig: Function) {
                if (s.enableThemes) return true;
                return orig.apply(this, args);
            })
        );
    }
}

// Patch soundboard availability
function patchSoundboard() {
    // Find soundboard module
    const SoundboardStore = findByProps("getSoundboardSounds", "getGuildSoundboardSounds");
    if (!SoundboardStore) return;

    // Patch to make all sounds available
    const origGetSounds = SoundboardStore.getSoundboardSounds;
    if (origGetSounds) {
        unpatches.push(
            instead(SoundboardStore, "getSoundboardSounds", function (this: any, args: any[], orig: Function) {
                const result = orig.apply(this, args);
                if (s.enableSoundboardBypass && result) {
                    // Mark all sounds as available
                    if (Array.isArray(result)) {
                        return result.map((sound: any) => ({
                            ...sound,
                            available: true
                        }));
                    }
                }
                return result;
            })
        );
    }
}

// Patch message sending to convert emojis/stickers to links
function patchMessageSending() {
    // Find the message send module
    const MessageActions = findByProps("sendMessage", "editMessage", "startEditMessage");
    if (!MessageActions) {
        logger.warn("FakeNitro: Could not find MessageActions module");
        return;
    }

    // Patch sendMessage
    if (typeof MessageActions.sendMessage === "function") {
        unpatches.push(
            before(MessageActions, "sendMessage", function (args: any[]) {
                const channelId = args[0];
                const message = args[1];
                if (!message || !channelId) return;

                processMessageForSending(channelId, message);
            })
        );
    }

    // Patch editMessage
    if (typeof MessageActions.editMessage === "function") {
        unpatches.push(
            before(MessageActions, "editMessage", function (args: any[]) {
                const channelId = args[0];
                const messageId = args[1];
                const message = args[2];
                if (!message || !channelId) return;

                processMessageForEditing(channelId, message);
            })
        );
    }
}

// Process message content for sending - convert unuseable emojis to links
function processMessageForSending(channelId: string, message: any) {
    if (!s.enableEmojiBypass && !s.enableStickerBypass) return;

    let content = message.content ?? "";
    const validEmojis = message.validNonShortcutEmojis ?? [];

    // Process stickers
    if (s.enableStickerBypass && message.stickers?.length > 0) {
        const sticker = StickersStore?.getStickerById(message.stickers[0]);
        if (sticker && !("pack_id" in sticker)) {
            const canUseStickers = (UserStore?.getCurrentUser()?.premiumType ?? 0) > 1;
            if (!canUseStickers || sticker.available === false) {
                const link = getStickerLink(sticker);
                const url = new URL(link);
                url.searchParams.set("name", sticker.name);

                const linkText = s.hyperLinkText.replaceAll("{{NAME}}", sticker.name);
                content += `${getWordBoundary(content, content.length - 1)}${s.useHyperLinks ? `[${linkText}](${url})` : url}`;

                // Clear stickers since we're sending as link
                message.stickers = [];
            }
        }
    }

    // Process emojis
    if (s.enableEmojiBypass && validEmojis.length > 0) {
        for (const emoji of validEmojis) {
            if (canUseEmote(emoji, channelId)) continue;

            const emojiString = `<${emoji.animated ? "a" : ""}:${emoji.originalName || emoji.name}:${emoji.id}>`;
            const link = buildEmojiLink(emoji);

            content = content.replace(emojiString, (match, offset, origStr) => {
                return `${getWordBoundary(origStr, offset - 1)}${link}${getWordBoundary(origStr, offset + match.length)}`;
            });
        }
    }

    // Also scan content for custom emoji patterns
    if (s.enableEmojiBypass) {
        content = content.replace(customEmojiRegex, (match, animated, name, id) => {
            const emoji = EmojiStore?.getCustomEmojiById(id);
            if (!emoji || canUseEmote(emoji, channelId)) return match;

            const fakeEmoji = {
                id: id,
                name: name,
                animated: animated === "a",
                originalName: name
            };
            return buildEmojiLink(fakeEmoji);
        });
    }

    message.content = content;
}

// Process message content for editing
function processMessageForEditing(channelId: string, message: any) {
    if (!s.enableEmojiBypass) return;

    let content = message.content ?? "";

    content = content.replace(customEmojiRegex, (match, animated, name, id) => {
        const emoji = EmojiStore?.getCustomEmojiById(id);
        if (!emoji || canUseEmote(emoji, channelId)) return match;

        const fakeEmoji = {
            id: id,
            name: name,
            animated: animated === "a",
            originalName: name
        };
        return buildEmojiLink(fakeEmoji);
    });

    message.content = content;
}

// Patch sticker availability in the sticker module
function patchStickerAvailability() {
    // Find the module that checks sticker availability
    const StickerUtils = findByProps("getStickerURL", "getStickerURLForMessageType");
    if (!StickerUtils) return;

    // Patch to always allow stickers
    if (typeof StickerUtils.canUseSticker === "function") {
        unpatches.push(
            instead(StickerUtils, "canUseSticker", function (this: any, args: any[], orig: Function) {
                if (s.enableStickerBypass) return true;
                return orig.apply(this, args);
            })
        );
    }
}

// Patch the premium subscription check in the user module
function patchUserPremium() {
    // Find and patch the premium type getter
    const UserSettings = findByProps("getCurrentUser", "getUser");
    if (!UserSettings) return;

    // Patch getCurrentUser to spoof premium type
    const origGetUser = UserSettings.getCurrentUser;
    if (origGetUser) {
        unpatches.push(
            instead(UserSettings, "getCurrentUser", function (this: any, args: any[], orig: Function) {
                const user = orig.apply(this, args);
                if (!user) return user;

                // Spoof premium type to 2 (Nitro) for feature access
                // But keep the real premiumType for display purposes
                return {
                    ...user,
                    premiumType: 2,
                    premium: true
                };
            })
        );
    }
}

// Settings component
const Settings = () => {
    const [refresh, setRefresh] = React.useState(0);
    const rerender = () => setRefresh(r => r + 1);

    const ToggleSetting = ({ label, description, value, onChange }: any) => (
        <FormSection>
            <Switch
                value={value}
                onValueChange={(v: boolean) => {
                    onChange(v);
                    rerender();
                }}
            >
                <Text variant="text-md/normal">{label}</Text>
                {description && (
                    <Text variant="text-xs/normal" color="text-muted">
                        {description}
                    </Text>
                )}
            </Switch>
        </FormSection>
    );

    const SliderSetting = ({ label, description, value, min, max, step, onChange }: any) => (
        <FormSection>
            <Text variant="text-md/normal">{label}: {value}</Text>
            {description && (
                <Text variant="text-xs/normal" color="text-muted">
                    {description}
                </Text>
            )}
            <Slider
                value={value}
                min={min}
                max={max}
                step={step}
                onValueChange={(v: number) => {
                    onChange(Math.round(v));
                    rerender();
                }}
            />
        </FormSection>
    );

    return (
        <General.Scroller>
            <FormSection>
                <FormText type={Forms.FormText.Types.HEADER}>Emoji Settings</FormText>
            </FormSection>

            <ToggleSetting
                label="Enable Emoji Bypass"
                description="Allows sending fake emojis (also bypasses missing permission)"
                value={s.enableEmojiBypass}
                onChange={(v: boolean) => { s.enableEmojiBypass = v; }}
            />

            <SliderSetting
                label="Emoji Size"
                description="Size of the emojis when sending"
                value={s.emojiSize}
                min={32}
                max={512}
                step={16}
                onChange={(v: number) => { s.emojiSize = v; }}
            />

            <ToggleSetting
                label="Transform Emojis"
                description="Whether to transform fake emojis into real ones when viewing"
                value={s.transformEmojis}
                onChange={(v: boolean) => { s.transformEmojis = v; }}
            />

            <FormDivider />

            <FormSection>
                <FormText type={Forms.FormText.Types.HEADER}>Sticker Settings</FormText>
            </FormSection>

            <ToggleSetting
                label="Enable Sticker Bypass"
                description="Allows sending fake stickers"
                value={s.enableStickerBypass}
                onChange={(v: boolean) => { s.enableStickerBypass = v; }}
            />

            <SliderSetting
                label="Sticker Size"
                description="Size of the stickers when sending"
                value={s.stickerSize}
                min={32}
                max={512}
                step={32}
                onChange={(v: number) => { s.stickerSize = v; }}
            />

            <ToggleSetting
                label="Transform Stickers"
                description="Whether to transform fake stickers into real ones when viewing"
                value={s.transformStickers}
                onChange={(v: boolean) => { s.transformStickers = v; }}
            />

            <ToggleSetting
                label="Transform Compound Sentences"
                description="Transform fake items in sentences with more content than just the fake link"
                value={s.transformCompoundSentence}
                onChange={(v: boolean) => { s.transformCompoundSentence = v; }}
            />

            <FormDivider />

            <FormSection>
                <FormText type={Forms.FormText.Types.HEADER}>Other Settings</FormText>
            </FormSection>

            <ToggleSetting
                label="Enable Stream Quality Bypass"
                description="Allow streaming in nitro quality"
                value={s.enableStreamQualityBypass}
                onChange={(v: boolean) => { s.enableStreamQualityBypass = v; }}
            />

            <ToggleSetting
                label="Enable Nitro Themes"
                description="Allow using premium client themes"
                value={s.enableThemes}
                onChange={(v: boolean) => { s.enableThemes = v; }}
            />

            <ToggleSetting
                label="Enable Soundboard Bypass"
                description="Make all soundboard sounds available"
                value={s.enableSoundboardBypass}
                onChange={(v: boolean) => { s.enableSoundboardBypass = v; }}
            />

            <ToggleSetting
                label="Use HyperLinks"
                description="Whether to use hyperlinks when sending fake emojis/stickers"
                value={s.useHyperLinks}
                onChange={(v: boolean) => { s.useHyperLinks = v; }}
            />

            <ToggleSetting
                label="Disable Embed Permission Check"
                description="Skip the embed permission check when sending fake items"
                value={s.disableEmbedPermissionCheck}
                onChange={(v: boolean) => { s.disableEmbedPermissionCheck = v; }}
            />
        </General.Scroller>
    );
};

// React import
declare const React: any;

export const onLoad = () => {
    logger.log("FakeNitro: Loading...");

    // Find Discord modules
    findModules();

    // Apply patches
    patchPremiumChecks();
    patchUserPremium();
    patchStickerAvailability();
    patchSoundboard();
    patchMessageSending();
    patchEmojiRendering();
    patchStickerRendering();

    logger.log("FakeNitro: Loaded successfully");
    showToast("FakeNitro", "Plugin loaded!");
};

export const onUnload = () => {
    logger.log("FakeNitro: Unloading...");

    // Remove all patches
    unpatchAll();
    unpatches.forEach(fn => fn());

    logger.log("FakeNitro: Unloaded");
};

export const settings = Settings;
