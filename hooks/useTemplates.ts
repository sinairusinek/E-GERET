import { useState, useEffect } from 'react';
import { ExtractionField, SavedTemplate } from '../types';

const STORAGE_KEY = 'egeret_templates_v3';

function safeGetStorage<T>(key: string, fallback: T): T {
  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : fallback;
  } catch {
    return fallback;
  }
}

function safeSetStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('localStorage write failed:', err);
  }
}

export function useTemplates() {
  const [fields, setFields] = useState<ExtractionField[]>([]);
  const [containerSelector, setContainerSelector] = useState<string>("");
  const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>(
    () => safeGetStorage(STORAGE_KEY, [])
  );
  const [activeTemplateId, setActiveTemplateId] = useState<string>("");
  const [showSavedToast, setShowSavedToast] = useState(false);

  useEffect(() => {
    safeSetStorage(STORAGE_KEY, savedTemplates);
  }, [savedTemplates]);

  const triggerToast = () => {
    setShowSavedToast(true);
    setTimeout(() => setShowSavedToast(false), 3000);
  };

  const saveNewTemplate = (
    name: string,
    fingerprint?: string,
    directContainerSelector?: string,
    directFields?: ExtractionField[]
  ) => {
    const newTemplate: SavedTemplate = {
      id: crypto.randomUUID(),
      name,
      containerSelector: directContainerSelector ?? containerSelector,
      fields: [...(directFields ?? fields)],
      createdAt: Date.now(),
      ...(fingerprint ? { fingerprint } : {}),
    };
    setSavedTemplates(prev => [newTemplate, ...prev]);
    setActiveTemplateId(newTemplate.id);
    triggerToast();
    return newTemplate;
  };

  const updateExistingTemplate = () => {
    if (!activeTemplateId) return;
    setSavedTemplates(prev => prev.map(t =>
      t.id === activeTemplateId
        ? { ...t, containerSelector, fields: [...fields] }
        : t
    ));
    triggerToast();
  };

  const loadTemplate = (tpl: SavedTemplate) => {
    setContainerSelector(tpl.containerSelector);
    setFields([...tpl.fields]);
    setActiveTemplateId(tpl.id);
  };

  const deleteTemplate = (id: string) => {
    setSavedTemplates(prev => prev.filter(t => t.id !== id));
    if (activeTemplateId === id) setActiveTemplateId("");
  };

  const handleAddField = () => {
    const newField: ExtractionField = {
      id: crypto.randomUUID(),
      name: `Field_${fields.length + 1}`,
      description: "",
      selector: ""
    };
    setFields([...fields, newField]);
  };

  const updateField = (fieldId: string, key: keyof ExtractionField, value: string) => {
    setFields(prev => prev.map(f => f.id === fieldId ? { ...f, [key]: value } : f));
  };

  const removeField = (fieldId: string) => {
    setFields(prev => prev.filter(f => f.id !== fieldId));
  };

  const findByFingerprint = (fp: string): SavedTemplate | null => {
    return savedTemplates.find(t => t.fingerprint === fp) || null;
  };

  const setTemplateFingerprint = (templateId: string, fingerprint: string) => {
    setSavedTemplates(prev => prev.map(t =>
      t.id === templateId ? { ...t, fingerprint } : t
    ));
  };

  return {
    savedTemplates,
    activeTemplateId,
    showSavedToast,
    fields,
    setFields,
    containerSelector,
    setContainerSelector,
    saveNewTemplate,
    updateExistingTemplate,
    loadTemplate,
    deleteTemplate,
    handleAddField,
    updateField,
    removeField,
    findByFingerprint,
    setTemplateFingerprint,
  };
}
