import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Image, Pressable, StyleProp, StyleSheet, Text, View, ViewStyle,
} from 'react-native';
import {
  DeskPhotoKey, DeskTextKey, getRecruitPhotoUri, JestersDeskContent,
} from '@/lib/recruitService';

const PAPER = '#E9D7B5';
const PAPER_LIGHT = '#F3E6CC';
const INK = '#211A13';
const RULE = '#644A2E';
const MUTED = '#79684F';
const RED = '#762B22';

type TextStyle = 'headline' | 'deck' | 'body' | 'small' | 'bullet' | 'quote';

export interface JestersDeskDocumentProps {
  width: number;
  content: JestersDeskContent;
  editable?: boolean;
  compact?: boolean;
  onEditText?: (field: DeskTextKey) => void;
  onPickPhoto?: (field: DeskPhotoKey) => void;
}

function niceLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function TextSlot({
  field, content, placeholder, variant = 'body', scale, editable, onPress,
}: {
  field: DeskTextKey;
  content: JestersDeskContent;
  placeholder: string;
  variant?: TextStyle;
  scale: number;
  editable?: boolean;
  onPress?: () => void;
}) {
  const value = content.text[field]?.trim();
  return (
    <Pressable
      testID={`desk-text-${field}`}
      accessibilityRole={editable ? 'button' : undefined}
      accessibilityLabel={editable ? `Edit ${niceLabel(field)}` : niceLabel(field)}
      onPress={editable ? onPress : undefined}
      disabled={!editable}
      style={[s.textSlot, editable && s.editableSlot]}
    >
      <Text style={[
        s.slotText,
        s[variant],
        {
          fontSize: (variant === 'headline' ? 27 : variant === 'deck' ? 15 : variant === 'small' ? 10 : variant === 'quote' ? 14 : 13) * scale,
          lineHeight: (variant === 'headline' ? 35 : variant === 'deck' ? 23 : variant === 'small' ? 18 : variant === 'quote' ? 23 : variant === 'bullet' ? 20 : 22) * scale,
          color: value ? INK : MUTED,
        },
        !value && s.placeholderText,
      ]}>
        {value || placeholder}
      </Text>
      {editable ? <Text style={[s.editTag, { fontSize: 8 * scale }]}>EDIT</Text> : null}
    </Pressable>
  );
}

function PhotoSlot({
  field, content, label = 'PHOTO HERE', aspectRatio = 1.55, scale, editable, onPress,
  containerStyle,
}: {
  field: DeskPhotoKey;
  content: JestersDeskContent;
  label?: string;
  aspectRatio?: number;
  scale: number;
  editable?: boolean;
  onPress?: () => void;
  containerStyle?: StyleProp<ViewStyle>;
}) {
  const path = content.photos[field];
  const [uri, setUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    setUri(null);
    if (!path) {
      setLoading(false);
      return;
    }
    setLoading(true);
    getRecruitPhotoUri(path)
      .then(next => { if (live) setUri(next); })
      .catch(() => { if (live) setUri(null); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [path]);

  return (
    <Pressable
      testID={`desk-photo-${field}`}
      accessibilityRole={editable ? 'button' : undefined}
      accessibilityLabel={editable ? `Add or change ${niceLabel(field)}` : label}
      onPress={editable ? onPress : undefined}
      disabled={!editable}
      style={[
        s.photoSlot,
        { aspectRatio: aspectRatio, borderWidth: Math.max(1, scale) },
        containerStyle,
        editable && s.editableSlot,
      ]}
    >
      {uri ? (
        <Image source={{ uri }} resizeMode="cover" style={StyleSheet.absoluteFill} />
      ) : (
        <View style={s.photoPlaceholder}>
          {loading
            ? <ActivityIndicator color={RULE} />
            : <Text style={[s.photoText, { fontSize: 12 * scale }]}>{editable ? 'TAP TO ADD PHOTO' : label}</Text>}
        </View>
      )}
      {editable && uri ? <Text style={[s.photoEditTag, { fontSize: 8 * scale }]}>CHANGE PHOTO</Text> : null}
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <View style={s.sectionHeading}>
        <View style={s.rule} />
        <Text style={s.sectionTitle}>{title}</Text>
        <View style={s.rule} />
      </View>
      {children}
    </View>
  );
}

function PaperPage({ children }: { children: React.ReactNode }) {
  return <View style={s.page}>{children}</View>;
}

function StaticLine({ children }: { children: string }) {
  return <Text style={s.staticLine}>{children}</Text>;
}

function PhotoTextCard({
  photo, title, copy, content, scale, editable, onEditText, onPickPhoto, horizontal = false,
}: {
  photo: DeskPhotoKey;
  title: DeskTextKey;
  copy: DeskTextKey;
  content: JestersDeskContent;
  scale: number;
  editable?: boolean;
  onEditText?: (field: DeskTextKey) => void;
  onPickPhoto?: (field: DeskPhotoKey) => void;
  horizontal?: boolean;
}) {
  return (
    <View style={horizontal ? s.archiveRow : s.archiveCard}>
      <View style={horizontal ? s.archiveThumb : undefined}>
        <PhotoSlot
          field={photo}
          content={content}
          aspectRatio={horizontal ? 1 : 1.35}
          scale={scale}
          editable={editable}
          onPress={() => onPickPhoto?.(photo)}
        />
      </View>
      <View style={horizontal ? s.archiveRowBody : undefined}>
        <TextSlot field={title} content={content} placeholder="A title goes here" variant="small" scale={scale} editable={editable} onPress={() => onEditText?.(title)} />
        <TextSlot field={copy} content={content} placeholder="A short story note goes here" variant="small" scale={scale} editable={editable} onPress={() => onEditText?.(copy)} />
      </View>
    </View>
  );
}

export default function JestersDeskDocument({
  width, content, editable, compact, onEditText, onPickPhoto,
}: JestersDeskDocumentProps) {
  const scale = width < 230 ? 0.52 : Math.max(0.86, Math.min(1.14, width / 390));
  const slot = (field: DeskTextKey, placeholder: string, variant: TextStyle = 'body') => (
    <TextSlot
      key={field}
      field={field}
      content={content}
      placeholder={placeholder}
      variant={variant}
      scale={scale}
      editable={editable}
      onPress={() => onEditText?.(field)}
    />
  );
  const photo = (field: DeskPhotoKey, label?: string, aspectRatio = 1.55, inline = false) => (
    <PhotoSlot
      key={field}
      field={field}
      content={content}
      label={label}
      aspectRatio={aspectRatio}
      scale={scale}
      editable={editable}
      onPress={() => onPickPhoto?.(field)}
      containerStyle={inline ? s.inlinePhoto : undefined}
    />
  );

  return (
    <View style={[s.document, { width, padding: 10 * scale }]}>
      <PaperPage>
        <View style={s.metaRow}>
          <View style={s.metaCell}>{slot('volume', 'VOL. I. NO. 1', 'small')}</View>
          <View style={s.metaCell}>{slot('edition', 'MORNING EDITION', 'small')}</View>
          <View style={s.metaCell}>{slot('date', 'DATE: ENTER DATE HERE', 'small')}</View>
          <View style={s.metaCell}>{slot('edition_number', '7TH EDITION', 'small')}</View>
        </View>
        <Text style={[s.masthead, { fontSize: 32 * scale, lineHeight: 38 * scale }]}>THE JESTER’S DESK</Text>
        {slot('tagline', 'A DIGITAL NEWSPAPER FOR UPDATES, STORIES, AND MORE', 'small')}
        <StaticLine>HOME　 |　 NEWS　 |　 FEATURES　 |　 SERIALS　 |　 ARCHIVES　 |　 ABOUT</StaticLine>

        <View style={s.leadGrid}>
          <View style={s.leadStory}>
            {slot('main_headline', 'MAIN HEADLINE GOES HERE', 'headline')}
            {slot('main_subtitle', 'A SUBHEADLINE OR TAGLINE FOR THE LEAD STORY GOES HERE', 'deck')}
            <View style={s.byline}>
              {slot('byline', 'BY: AUTHOR NAME', 'small')}
              {slot('main_date', 'DATE: ENTER DATE HERE', 'small')}
            </View>
            {photo('main_photo', 'PHOTO HERE', 2.15)}
            {slot('story_intro', 'A short introduction or lead paragraph for the main story goes here.', 'body')}
            {slot('story_body', 'Add the rest of the story here. Tap this area to write the full story.', 'body')}
            <Text style={s.readLink}>READ THE FULL STORY　→</Text>
          </View>
          {!compact ? (
            <View style={s.sideColumn}>
              <Section title="Quick News">
                {slot('quick_news_1', 'Quick headline or update one')}
                {slot('quick_news_2', 'Quick headline or update two')}
                {slot('quick_news_3', 'Quick headline or update three')}
              </Section>
              <Section title="Inside This Edition">
                {slot('inside_edition_1', 'Topic or section one')}
                {slot('inside_edition_2', 'Topic or section two')}
                {slot('inside_edition_3', 'Topic or section three')}
                {slot('inside_edition_4', 'Topic or section four')}
              </Section>
            </View>
          ) : null}
        </View>

        {!compact ? (
          <>
            <View style={s.twoColumns}>
              <Section title="Announcements">
                {slot('announcements_intro', 'Share an important update or reminder.')}
                {slot('announcement_1', 'Site update or new section')}
                {slot('announcement_2', 'A reminder or important note')}
                {slot('announcement_3', 'Another quick update')}
              </Section>
              <Section title="Short Notes">
                {slot('short_note_1', 'A brief note or highlight')}
                {slot('short_note_2', 'Another short note')}
                {slot('short_note_3', 'One more quick item')}
              </Section>
            </View>
            <View style={s.twoColumns}>
              <Section title="Feature Highlight">
                {photo('feature_photo', 'PHOTO HERE', 1.7)}
                {slot('feature_title', 'A special focus or featured story', 'deck')}
                {slot('feature_summary', 'A highlighted article or special feature goes here.', 'small')}
              </Section>
              <Section title="Editor’s Note">
                {slot('editor_note', 'A short message from the editor goes here.', 'body')}
                <Text style={s.signature}>— The Editor</Text>
              </Section>
            </View>
            <View style={s.twoColumns}>
              <Section title="Serial Update">
                {slot('serial_title', 'The latest from an ongoing series', 'deck')}
                {photo('serial_photo', 'PHOTO HERE', 2)}
                {slot('serial_summary', 'An update on the latest installment.', 'small')}
              </Section>
              <Section title="A Closer Look">
                {slot('closer_title', 'A deeper dive into a key detail', 'deck')}
                {photo('closer_photo', 'PHOTO HERE', 2)}
                {slot('closer_summary', 'Take a closer look at a specific detail or topic.', 'small')}
              </Section>
            </View>
            <Text style={s.continueText}>SCROLL DOWN FOR MORE　⌄</Text>
          </>
        ) : null}
      </PaperPage>

      {!compact ? (
        <>
          <PaperPage>
            <Text style={s.continueText}>THE JESTER’S DESK CONTINUES</Text>
            <Section title="Special Feature">
              {slot('special_title', 'SPECIAL FEATURE HEADLINE GOES HERE', 'headline')}
              {slot('special_subtitle', 'A closer look at the story behind the headline', 'deck')}
              <View style={s.twoColumns}>
              {photo('special_photo', 'PHOTO HERE', 1.5, true)}
              <View style={s.summaryColumn}>
                {slot('special_summary', 'A key introduction or summary for this featured story.', 'body')}
              </View>
              </View>
              <Text style={s.readLink}>READ THE FULL FEATURE　→</Text>
            </Section>
            <View style={s.twoColumns}>
              <Section title="The Details">
                {slot('details_title', 'Key facts and context', 'deck')}
                {slot('details_body', 'A clear overview of the main details.', 'body')}
                {slot('detail_point_1', 'Key point or fact here', 'bullet')}
                {slot('detail_point_2', 'Another important detail', 'bullet')}
                {slot('detail_point_3', 'A related note or takeaway', 'bullet')}
              </Section>
              <Section title="Behind the Story">
                {slot('behind_title', 'The context, the process, and the bigger picture', 'deck')}
                {slot('behind_body', 'A short look at how the story came together.', 'body')}
              </Section>
            </View>
            <View style={s.twoColumns}>
              <Section title="How It Unfolds">
                {slot('timeline_1', '1. First development')}
                {slot('timeline_2', '2. Next turning point')}
                {slot('timeline_3', '3. Major moment')}
                {slot('timeline_4', '4. What comes next')}
              </Section>
              <Section title="Reader Notes">
                {slot('reader_note_1', 'A short reader comment or question')}
                {slot('reader_note_2', 'Another reader thought')}
                {slot('reader_note_3', 'A third comment or takeaway')}
              </Section>
            </View>
            <View style={s.twoColumns}>
              <Section title="From the Desk">
                {slot('from_desk_note', 'An editorial note or perspective from the desk.', 'body')}
              </Section>
              <View style={s.section}>
                {photo('from_desk_photo', 'PHOTO HERE', 1.2)}
                {slot('photo_caption', 'A related photo caption or context', 'small')}
              </View>
            </View>
            <View style={s.twoColumns}>
              <Section title="Announcement Board">
                {slot('board_item_1', 'Site update or new section')}
                {slot('board_item_2', 'A special announcement')}
                {slot('board_item_3', 'A reminder or quick update')}
              </Section>
              <Section title="Upcoming">
                {slot('schedule_1', 'APR 10 — Upcoming topic or feature')}
                {slot('schedule_2', 'APR 14 — Live update or special post')}
                {slot('schedule_3', 'APR 18 — New series or deep dive')}
                {slot('schedule_4', 'APR 22 — Follow-up or next chapter')}
              </Section>
            </View>
            <Section title="What’s Next">
              {slot('whats_next', 'A brief look at upcoming coverage and stories.', 'body')}
              <View style={s.twoColumns}>
                <View style={s.section}>
                  {photo('upcoming_photo_1', 'PHOTO HERE', 1.45)}
                  {slot('next_topic_1', 'UPCOMING TOPIC PREVIEW', 'small')}
                </View>
                <View style={s.section}>
                  {photo('upcoming_photo_2', 'PHOTO HERE', 1.45)}
                  {slot('next_topic_2', 'ANOTHER FEATURE AHEAD', 'small')}
                </View>
              </View>
            </Section>
          </PaperPage>

          <PaperPage>
            <Text style={s.continueText}>THE JESTER’S DESK CONTINUES</Text>
            <Section title="Archive Spotlight">
              {slot('archive_spotlight_title', 'Popular stories from the Jester’s archive', 'deck')}
              <View style={s.threeColumns}>
                <PhotoTextCard photo="archive_spotlight_photo_1" title="archive_story_1_title" copy="archive_story_1_copy" content={content} scale={scale} editable={editable} onEditText={onEditText} onPickPhoto={onPickPhoto} />
                <PhotoTextCard photo="archive_spotlight_photo_2" title="archive_story_2_title" copy="archive_story_2_copy" content={content} scale={scale} editable={editable} onEditText={onEditText} onPickPhoto={onPickPhoto} />
                <PhotoTextCard photo="archive_spotlight_photo_3" title="archive_story_3_title" copy="archive_story_3_copy" content={content} scale={scale} editable={editable} onEditText={onEditText} onPickPhoto={onPickPhoto} />
              </View>
            </Section>
            <View style={s.twoColumns}>
              <Section title="Reader Favorites">
                {slot('favorite_1', 'A reader-loved story')}
                {slot('favorite_2', 'Another top read')}
                {slot('favorite_3', 'A classic from the desk')}
                <Text style={s.readLink}>SEE ALL READER FAVORITES　→</Text>
              </Section>
              <Section title="From the Archive">
                {slot('from_archive_title', 'Older stories, fresh interest', 'deck')}
                <View style={s.archiveList}>
                  <PhotoTextCard horizontal photo="archive_photo_1" title="archive_item_1_title" copy="archive_item_1_copy" content={content} scale={scale} editable={editable} onEditText={onEditText} onPickPhoto={onPickPhoto} />
                  <PhotoTextCard horizontal photo="archive_photo_2" title="archive_item_2_title" copy="archive_item_2_copy" content={content} scale={scale} editable={editable} onEditText={onEditText} onPickPhoto={onPickPhoto} />
                  <PhotoTextCard horizontal photo="archive_photo_3" title="archive_item_3_title" copy="archive_item_3_copy" content={content} scale={scale} editable={editable} onEditText={onEditText} onPickPhoto={onPickPhoto} />
                </View>
              </Section>
            </View>
            <Section title="People I Trust">
              <View style={s.twoColumns}>
                {photo('trusted_people_photo', 'PHOTO HERE', 1.35, true)}
                <View style={s.summaryColumn}>
                  {slot('trusted_people_caption', 'Add a photo caption or note about the people you trust.', 'body')}
                </View>
              </View>
            </Section>
            <Section title="Stay Connected">
              {slot('stay_connected_copy', 'News, updates, and more from the Jester’s Desk.', 'deck')}
              <View style={s.twoColumns}>
                <View style={s.section}>
                  {slot('newsletter_copy', 'Get the Desk Dispatch with new stories and updates.', 'small')}
                  {slot('newsletter_email', 'YOUR EMAIL HERE', 'small')}
                  {slot('newsletter_button', 'SIGN UP', 'small')}
                </View>
                <View style={s.section}>
                  {slot('follow_copy', 'Follow and subscribe for updates and community highlights.', 'small')}
                  {slot('follow_1', 'Follow on social')}
                  {slot('follow_2', 'Subscribe to video')}
                  {slot('follow_3', 'Join the community')}
                  {slot('follow_4', 'Get update alerts')}
                </View>
              </View>
            </Section>
            <Section title="Submit a Whisper">
              {slot('whisper_title', 'Have a tip, topic, or story idea?', 'deck')}
              <View style={s.twoColumns}>
                {photo('whisper_photo', 'PHOTO HERE', 1.3, true)}
                <View style={s.section}>
                  {slot('whisper_copy', 'Share a story lead, curious find, or idea for future features.', 'body')}
                  {slot('whisper_button', 'SEND A WHISPER TO THE DESK　→', 'small')}
                </View>
              </View>
            </Section>
            <View style={s.twoColumns}>
              <Section title="Final Note">
                {slot('final_note_body', 'A brief editorial note to close the edition.', 'body')}
              </Section>
              <Section title="The Jester Says">
                {slot('jester_says', 'A short, memorable quote or parting thought.', 'quote')}
                <Text style={s.signature}>— THE JESTER’S DESK</Text>
              </Section>
            </View>
            <View style={s.footer}>
              <Text style={s.mastheadSmall}>THE JESTER’S DESK</Text>
              <StaticLine>STORIES　 •　 FEATURES　 •　 ARCHIVE　 •　 COMMUNITY</StaticLine>
              <StaticLine>EXPLORE　 |　 EDITION & ARCHIVE　 |　 ABOUT & CONTACT</StaticLine>
              <Text style={s.footerNote}>© THE JESTER’S DESK　 |　 ALL RIGHTS RESERVED</Text>
            </View>
          </PaperPage>
        </>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  document: { backgroundColor: '#C4A77A' },
  page: {
    backgroundColor: PAPER,
    borderWidth: 1.5, borderColor: RULE,
    padding: 14, marginBottom: 12,
    shadowColor: '#23180C', shadowOpacity: 0.18, shadowRadius: 5, shadowOffset: { width: 0, height: 2 },
  },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 3, borderBottomWidth: 1, borderBottomColor: RULE, paddingBottom: 5 },
  metaCell: { flexGrow: 1, flexBasis: '48%', minWidth: 0, flexDirection: 'column' },
  masthead: { color: INK, fontFamily: 'PlayfairDisplay_700Bold', fontWeight: '900', textAlign: 'center', letterSpacing: 0.8, marginTop: 8, marginBottom: 2 },
  mastheadSmall: { color: INK, fontFamily: 'PlayfairDisplay_700Bold', fontSize: 19, textAlign: 'center', letterSpacing: 1.2 },
  staticLine: { color: INK, fontFamily: 'PlayfairDisplay_700Bold', fontSize: 9, textAlign: 'center', marginVertical: 5, letterSpacing: 0.4 },
  textSlot: { position: 'relative', flexShrink: 1, paddingVertical: 4, paddingHorizontal: 3, marginVertical: 1 },
  editableSlot: { borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(118,43,34,0.48)', backgroundColor: 'rgba(255,250,238,0.28)', paddingTop: 13 },
  slotText: { color: INK, fontFamily: 'EBGaramond_400Regular', flexShrink: 1 },
  headline: { fontFamily: 'PlayfairDisplay_700Bold', fontWeight: '900', textAlign: 'center', letterSpacing: -0.4 },
  deck: { fontFamily: 'EBGaramond_400Regular_Italic', fontStyle: 'italic', textAlign: 'center' },
  body: { fontFamily: 'EBGaramond_400Regular' },
  small: { fontFamily: 'EBGaramond_700Bold', textAlign: 'center' },
  bullet: { fontFamily: 'EBGaramond_400Regular', borderBottomWidth: 0.5, borderColor: 'rgba(100,74,46,0.35)' },
  archiveList: { gap: 6 },
  quote: { fontFamily: 'EBGaramond_400Regular_Italic', fontStyle: 'italic', textAlign: 'center' },
  placeholderText: { fontStyle: 'italic', opacity: 0.8 },
  editTag: { position: 'absolute', right: 3, top: 2, color: RED, backgroundColor: PAPER, paddingHorizontal: 2, zIndex: 1, fontFamily: 'Inter_700Bold', letterSpacing: 0.5 },
  photoSlot: {
    width: '100%', overflow: 'hidden', borderColor: RULE,
    backgroundColor: PAPER_LIGHT, alignItems: 'center', justifyContent: 'center', marginVertical: 5,
  },
  photoPlaceholder: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center', padding: 8 },
  photoText: { color: MUTED, fontFamily: 'PlayfairDisplay_700Bold', textAlign: 'center', letterSpacing: 0.6 },
  photoEditTag: { position: 'absolute', right: 4, bottom: 4, backgroundColor: PAPER_LIGHT, color: RED, paddingHorizontal: 5, paddingVertical: 2, fontFamily: 'Inter_700Bold' },
  leadGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, borderTopWidth: 2, borderBottomWidth: 2, borderColor: INK, paddingVertical: 8, marginTop: 7 },
  leadStory: { flex: 1.35, minWidth: 190 },
  sideColumn: { flex: 0.85, minWidth: 150 },
  inlinePhoto: { flexGrow: 1, flexShrink: 1, flexBasis: '42%', minWidth: 120, width: 'auto' },
  summaryColumn: { flex: 1, minWidth: 135 },
  byline: { flexDirection: 'row', gap: 6, justifyContent: 'space-between', marginVertical: 2 },
  section: { flex: 1, minWidth: 135, borderWidth: 1, borderColor: 'rgba(100,74,46,0.68)', padding: 7, marginVertical: 4, backgroundColor: 'rgba(255,248,233,0.17)' },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 5 },
  sectionTitle: { color: INK, fontFamily: 'PlayfairDisplay_700Bold', fontSize: 13, textAlign: 'center', textTransform: 'uppercase', flexShrink: 1 },
  rule: { height: 1, backgroundColor: RULE, flex: 1 },
  twoColumns: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', alignContent: 'flex-start', gap: 7, marginTop: 5 },
  threeColumns: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  archiveCard: { flex: 1, minWidth: 95, borderWidth: 1, borderColor: 'rgba(100,74,46,0.55)', padding: 4, marginVertical: 3 },
  archiveRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 5, borderWidth: 1, borderColor: 'rgba(100,74,46,0.5)', padding: 3, marginVertical: 2 },
  archiveThumb: { width: 48, flexShrink: 0 },
  archiveRowBody: { flex: 1, minWidth: 0 },
  readLink: { color: INK, fontFamily: 'PlayfairDisplay_700Bold', textAlign: 'center', textDecorationLine: 'underline', fontSize: 10, marginTop: 5 },
  signature: { color: INK, fontFamily: 'EBGaramond_400Regular_Italic', fontStyle: 'italic', textAlign: 'right', marginTop: 5 },
  continueText: { color: INK, fontFamily: 'PlayfairDisplay_700Bold', textAlign: 'center', letterSpacing: 1.2, marginVertical: 8, fontSize: 11 },
  footer: { borderTopWidth: 2, borderColor: RULE, marginTop: 8, paddingTop: 8, alignItems: 'center' },
  footerNote: { color: MUTED, fontFamily: 'EBGaramond_400Regular', fontSize: 9, textAlign: 'center', marginTop: 4 },
});
