import { useState, useRef } from 'react';
import { UploadedFile, AppStatus } from '../types';

export function useFileUpload() {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [uploadStatus, setUploadStatus] = useState<AppStatus>(AppStatus.IDLE);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = Array.from(e.target.files || []);
    if (uploadedFiles.length === 0) return;

    setUploadStatus(AppStatus.UPLOADING);

    try {
      const readPromises = uploadedFiles.map(
        (file) =>
          new Promise<UploadedFile>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (event) => {
              if (event.target?.result) {
                resolve({
                  id: crypto.randomUUID(),
                  name: file.name,
                  size: file.size,
                  type: file.type,
                  content: event.target.result as string,
                });
              } else {
                reject(new Error(`Empty result for ${file.name}`));
              }
            };
            reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
            reader.readAsText(file);
          })
      );
      const newFiles = await Promise.all(readPromises);
      setFiles((prev) => [...prev, ...newFiles]);
    } catch (err) {
      console.error("File upload error:", err);
    } finally {
      setUploadStatus(AppStatus.IDLE);
      if (e.target) e.target.value = '';
    }
  };

  const triggerUpload = (e: React.MouseEvent) => {
    e.preventDefault();
    fileInputRef.current?.click();
  };

  const clearFiles = () => {
    setFiles([]);
  };

  return {
    files,
    uploadStatus,
    fileInputRef,
    handleFileUpload,
    triggerUpload,
    clearFiles,
  };
}
