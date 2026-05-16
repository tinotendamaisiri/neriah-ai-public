// src/utils/filePicker.ts
// Shared file-picking utilities: camera, gallery, and document picker.
// Shows an action sheet with all three options.
//
// Pass `cameraOpener` to handle the camera action via InAppCamera instead of
// the system camera picker. HomeworkDetailScreen does this.

import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';

export interface PickedFile {
  uri: string;
  name: string;
  mimeType: string;
  isImage: boolean;
  size?: number;
}

const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
];

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

/** Show an action sheet and return the picked file, or null if cancelled. */
export function pickFile(
  labels: {
    title?: string;
    takePhoto?: string;
    gallery?: string;
    uploadFile?: string;
    cancel?: string;
  } = {},
  /**
   * Optional: if provided, the "Take Photo" action calls this function instead
   * of opening the system camera picker. Use this to wire up InAppCamera.
   */
  cameraOpener?: () => Promise<PickedFile | null>,
): Promise<PickedFile | null> {
  return new Promise((resolve) => {
    Alert.alert(
      labels.title ?? 'Add file',
      undefined,
      [
        {
          text: labels.takePhoto ?? 'Take Photo',
          onPress: () => (cameraOpener ? cameraOpener() : fromGallery()).then(resolve),
        },
        {
          text: labels.gallery ?? 'Choose from Gallery',
          onPress: () => fromGallery().then(resolve),
        },
        {
          text: labels.uploadFile ?? 'Upload File (PDF, Word)',
          onPress: () => fromDocumentPicker().then(resolve),
        },
        {
          text: labels.cancel ?? 'Cancel',
          style: 'cancel',
          onPress: () => resolve(null),
        },
      ],
    );
  });
}

async function fromGallery(): Promise<PickedFile | null> {
  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (status !== 'granted') {
    Alert.alert('Permission needed', 'Please allow photo library access in Settings.');
    return null;
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: 'images',
    quality: 0.85,
  });
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  const name = asset.uri.split('/').pop() ?? 'image.jpg';
  return {
    uri: asset.uri,
    name,
    mimeType: asset.mimeType ?? 'image/jpeg',
    isImage: true,
    size: asset.fileSize,
  };
}

async function fromDocumentPicker(): Promise<PickedFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ACCEPTED_MIME_TYPES,
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets?.[0]) return null;
  const asset = result.assets[0];
  if (asset.size && asset.size > MAX_FILE_BYTES) {
    Alert.alert('File too large', 'Please choose a file smaller than 20MB.');
    return null;
  }
  const mime = asset.mimeType ?? 'application/octet-stream';
  const isImage = mime.startsWith('image/');
  return {
    uri: asset.uri,
    name: asset.name,
    mimeType: mime,
    isImage,
    size: asset.size,
  };
}
