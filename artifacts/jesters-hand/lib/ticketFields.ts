// Shared ticket field definitions.
// Field IDs are the Firestore keys and are identical for everyone;
// only the display text (label/placeholder) differs for 00-00.

// Suit marked on a member's ticket → glyph shown next to their Joker ID.
export const SUIT_GLYPHS: Record<string, string> = {
  Spade: '♠', Diamond: '♦', Heart: '♥', Club: '♣',
};

// On the ticket, the suit marks what book genre the member is reading right
// now (outside the Joker's Saga). Any joker can set their own.
export const SUIT_GENRES: Record<string, string> = {
  Spade: 'Thriller', Diamond: 'Organized Crime', Heart: 'Dark Romance', Club: 'Mystery',
};

export interface TicketField {
  id: string;
  label: string;
  placeholder: string;
  multiline: boolean;
  height: number;
}

export const FIELDS: TicketField[] = [
  { id: 'name',       label: 'Name',            placeholder: 'Your name',                      multiline: false, height: 48  },
  { id: 'street',     label: 'Street Name',     placeholder: 'Your nickname',                  multiline: false, height: 48  },
  { id: 'role',       label: 'Role',            placeholder: 'Your favorite role in the Joker Saga.', multiline: false, height: 48 },
  { id: 'state',      label: 'State',           placeholder: 'State',                          multiline: false, height: 48  },
  { id: 'country',    label: 'Country',         placeholder: 'Country',                        multiline: false, height: 48  },
  { id: 'firstjest',  label: 'First Jest',      placeholder: 'Who you are and what you do',    multiline: true,  height: 110 },
  { id: 'patterns',   label: 'Patterns',        placeholder: 'Your habits and hobbies',        multiline: true,  height: 110 },
  { id: 'coffee',     label: 'Coffee',          placeholder: 'Your coffee order',              multiline: false, height: 48  },
  { id: 'donut',      label: 'Donut',           placeholder: 'Your donut order',               multiline: false, height: 48  },
  { id: 'juice',      label: 'Juice',           placeholder: 'Your juice order',               multiline: false, height: 48  },
  { id: 'codex',      label: 'Your Codex',      placeholder: 'What genres stick',              multiline: true,  height: 110 },
  { id: 'creed',      label: "Joker's Creed",   placeholder: 'Your creed',                     multiline: true,  height: 130 },
  { id: 'streetart',  label: 'Street Art',      placeholder: 'Your achievements',              multiline: true,  height: 130 },
  { id: 'haunting',   label: 'Your Haunting',   placeholder: 'What from the saga haunts you',  multiline: true,  height: 130 },
  { id: 'static',     label: 'Static',          placeholder: 'Books, movies, shows watching',  multiline: true,  height: 130 },
];

// 00-00 (The Jester) gets her own labels/placeholders — same field IDs so
// Firestore keys are identical; only the display text differs.
export const JESTER_FIELDS: TicketField[] = [
  { id: 'name',       label: 'Name',            placeholder: 'Your name',                      multiline: false, height: 48  },
  { id: 'street',     label: 'Street Name',     placeholder: 'Your nickname',                  multiline: false, height: 48  },
  { id: 'role',       label: 'Role',            placeholder: 'Your favorite role in the Joker Saga.', multiline: false, height: 48 },
  { id: 'state',      label: 'State',           placeholder: 'State',                          multiline: false, height: 48  },
  { id: 'country',    label: 'Country',         placeholder: 'Country',                        multiline: false, height: 48  },
  { id: 'firstjest',  label: 'First Jest',      placeholder: 'Who you are and what you do',    multiline: true,  height: 110 },
  { id: 'patterns',   label: 'First Dream',     placeholder: 'Origin',                         multiline: true,  height: 110 },
  { id: 'coffee',     label: 'Coffee',          placeholder: 'Your coffee order',              multiline: false, height: 48  },
  { id: 'donut',      label: 'Donut',           placeholder: 'Your donut order',               multiline: false, height: 48  },
  { id: 'juice',      label: 'Juice',           placeholder: 'Your juice order',               multiline: false, height: 48  },
  { id: 'codex',      label: 'Holy Ghost',      placeholder: 'Muse',                           multiline: true,  height: 110 },
  { id: 'creed',      label: "Jester's Creed",  placeholder: 'Your creed',                     multiline: true,  height: 130 },
  { id: 'streetart',  label: 'Street Art',      placeholder: 'Your achievements',              multiline: true,  height: 130 },
  { id: 'haunting',   label: 'Hidden Jest',     placeholder: 'Easter Egg',                     multiline: true,  height: 130 },
  { id: 'static',     label: 'Current Target',  placeholder: 'What Am I Tackling?',            multiline: true,  height: 130 },
];

export const JESTER_JOKER_ID = '00-00';

export function fieldsForJokerId(jokerId?: string | null): TicketField[] {
  return jokerId === JESTER_JOKER_ID ? JESTER_FIELDS : FIELDS;
}
