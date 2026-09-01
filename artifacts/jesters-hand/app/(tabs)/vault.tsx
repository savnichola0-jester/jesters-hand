import React from 'react';
import VaultFolderScreen, { FolderConfig } from '@/components/vault/VaultFolderScreen';

const VAULT: FolderConfig = {
  name: 'Vault',
  watermarkPrefix: 'VAULT ACCESS',
  notice: 'Protected Vault Material — View Only',
  bookReviewSection: 'stack',
  sections: [
    {
      id: 'stack',
      label: 'THE STACK',
      displayName: 'The Stack',
      empty: 'The Stack is empty. Nothing has been locked in yet.',
      emptyIcon: 'book',
      adminBtn: 'LOAD THE STACK',
      viewBtn: 'OPEN FILE',
      sheetTitle: 'Load the Stack',
      success: 'Added to the Stack.',
      titleLabel: 'FILE TITLE',
      titlePlaceholder: 'File title',
      descLabel: 'FILE DESCRIPTION',
      uploadLabel: 'UPLOAD READING FILE',
      uploadPlaceholder: 'Choose a reading file',
      missingFileMsg: 'Pick a reading file to lock in.',
      fileKind: 'document',
      hasCover: true,
    },
    {
      id: 'wall',
      label: 'THE WALL',
      displayName: 'The Wall',
      empty: 'The Wall is bare. Nothing has been added yet.',
      emptyIcon: 'image',
      adminBtn: 'ADD TO THE WALL',
      viewBtn: 'VIEW PIECE',
      sheetTitle: 'Add to the Wall',
      success: 'Added to the Wall.',
      titleLabel: 'PIECE TITLE',
      titlePlaceholder: 'Piece title',
      descLabel: 'PIECE DESCRIPTION',
      uploadLabel: 'UPLOAD ARTWORK',
      uploadPlaceholder: 'Choose artwork',
      missingFileMsg: 'Pick artwork to lock in.',
      fileKind: 'image',
      hasCover: false,
    },
  ],
};

export default function VaultScreen() {
  return <VaultFolderScreen config={VAULT} />;
}
