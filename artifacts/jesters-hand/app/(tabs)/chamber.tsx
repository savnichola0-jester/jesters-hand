import React from 'react';
import VaultFolderScreen, { FolderConfig } from '@/components/vault/VaultFolderScreen';

// The Chamber — author notes (The Margins) and deleted/alternate scenes
// (The Cut). Same protected backend, permissions, watermarking, and admin
// controls as the Vault; only the labels and content types differ.
const CHAMBER: FolderConfig = {
  name: 'Chamber',
  watermarkPrefix: 'CHAMBER ACCESS',
  notice: 'Protected Chamber Material — View Only',
  sections: [
    {
      id: 'margins',
      label: 'THE MARGINS',
      displayName: 'The Margins',
      empty: 'The Margins are empty. Nothing has been locked in yet.',
      emptyIcon: 'edit-3',
      adminBtn: 'LEAVE A NOTE',
      viewBtn: 'READ NOTE',
      sheetTitle: 'Leave a Note',
      success: 'Added to the Margins.',
      titleLabel: 'NOTE TITLE',
      titlePlaceholder: 'Note title',
      descLabel: 'NOTE DESCRIPTION',
      uploadLabel: 'UPLOAD NOTE FILE',
      uploadPlaceholder: 'Choose a note file',
      missingFileMsg: 'Pick a note file to lock in.',
      fileKind: 'document',
      hasCover: true,
      hasDecoder: true,
    },
    {
      id: 'cut',
      label: 'THE CUT',
      displayName: 'The Cut',
      empty: 'The Cut is empty. Nothing has been locked in yet.',
      emptyIcon: 'scissors',
      adminBtn: 'OPEN THE CUT',
      viewBtn: 'READ SCENE',
      sheetTitle: 'Open the Cut',
      success: 'Added to the Cut.',
      titleLabel: 'SCENE TITLE',
      titlePlaceholder: 'Scene title',
      descLabel: 'SCENE DESCRIPTION',
      uploadLabel: 'UPLOAD SCENE FILE',
      uploadPlaceholder: 'Choose a scene file',
      missingFileMsg: 'Pick a scene file to lock in.',
      fileKind: 'document',
      hasCover: true,
      hasDecoder: true,
    },
  ],
};

export default function ChamberScreen() {
  return <VaultFolderScreen config={CHAMBER} />;
}
