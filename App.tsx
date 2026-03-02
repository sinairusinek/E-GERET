
import React, { useState, useEffect, useRef } from 'react';
import { UploadedFile, ExtractionField, ExtractedData, AppStatus, SavedTemplate } from './types';
import { suggestTemplateFields, extractMetadata } from './services/geminiService';
import { Button } from './components/Button';
import { Card, CardHeader, CardContent } from './components/Card';

const STORAGE_KEY = 'egeret_templates_v3';

const App: React.FC = () => {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [fields, setFields] = useState<ExtractionField[]>([]);
  const [containerSelector, setContainerSelector] = useState<string>("");
  const [extractedResults, setExtractedResults] = useState<ExtractedData[]>([]);
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  
  // Use lazy initializer to prevent the empty state from overwriting localStorage on mount
  const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  });
  
  const [activeTemplateId, setActiveTemplateId] = useState<string>("");
  const [showSavedToast, setShowSavedToast] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Persistence: Save to localStorage whenever savedTemplates changes
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedTemplates));
  }, [savedTemplates]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles: File[] = Array.from(e.target.files || []);
    if (uploadedFiles.length === 0) return;

    setStatus(AppStatus.UPLOADING);
    const newFiles: UploadedFile[] = [];

    uploadedFiles.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          newFiles.push({
            id: Math.random().toString(36).substr(2, 9),
            name: file.name,
            size: file.size,
            type: file.type,
            content: event.target.result as string
          });
          
          if (newFiles.length === uploadedFiles.length) {
            setFiles(prev => [...prev, ...newFiles]);
            setStatus(AppStatus.IDLE);
          }
        }
      };
      reader.readAsText(file);
    });
    
    // Clear the input value so the same file can be uploaded again if needed
    if (e.target) e.target.value = '';
  };

  const triggerUpload = (e: React.MouseEvent) => {
    e.preventDefault();
    fileInputRef.current?.click();
  };

  const handleSuggestTemplate = async () => {
    if (files.length === 0) {
      alert("Please upload at least one HTML file first.");
      return;
    }
    setStatus(AppStatus.GENERATING_TEMPLATE);
    try {
      const suggestion = await suggestTemplateFields(files[0].content);
      setFields(suggestion.fields);
      setContainerSelector(suggestion.containerSelector);
      setActiveTemplateId("");
    } catch (err) {
      console.error(err);
      alert("Failed to analyze HTML structure.");
    } finally {
      setStatus(AppStatus.IDLE);
    }
  };

  const saveNewTemplate = () => {
    const name = prompt("Name this extraction template:");
    if (!name) return;

    const newTemplate: SavedTemplate = {
      id: Math.random().toString(36).substr(2, 9),
      name,
      containerSelector,
      fields: [...fields], // clone
      createdAt: Date.now()
    };

    setSavedTemplates(prev => [newTemplate, ...prev]);
    setActiveTemplateId(newTemplate.id);
    triggerToast();
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

  const triggerToast = () => {
    setShowSavedToast(true);
    setTimeout(() => setShowSavedToast(false), 3000);
  };

  const loadTemplate = (tpl: SavedTemplate) => {
    setContainerSelector(tpl.containerSelector);
    setFields([...tpl.fields]);
    setActiveTemplateId(tpl.id);
  };

  const deleteTemplate = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("Delete this template permanently?")) {
      setSavedTemplates(prev => prev.filter(t => t.id !== id));
      if (activeTemplateId === id) setActiveTemplateId("");
    }
  };

  const handleAddField = () => {
    const newField: ExtractionField = {
      id: Math.random().toString(36).substr(2, 9),
      name: `Field_${fields.length + 1}`,
      description: "",
      selector: ""
    };
    setFields([...fields, newField]);
    // Optionally reset active template if it deviates
    // setActiveTemplateId("");
  };

  const runExtraction = async () => {
    if (files.length === 0 || !containerSelector || fields.length === 0) {
      alert("Configuration incomplete: Check sources, selector, and fields.");
      return;
    }
    
    setStatus(AppStatus.EXTRACTING);
    setExtractedResults([]);
    setProgress({ current: 0, total: files.length });

    const allResults: ExtractedData[] = [];
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const lettersData = await extractMetadata(file, containerSelector, fields);
        lettersData.forEach((data, index) => {
          allResults.push({
            id: `${file.id}-${index}`,
            fileId: file.id,
            fileName: file.name,
            letterIndex: index + 1,
            data
          });
        });
        setProgress({ current: i + 1, total: files.length });
      } catch (err) {
        console.error("Error processing " + file.name, err);
      }
    }

    setExtractedResults(allResults);
    setStatus(AppStatus.VIEWING_RESULTS);
  };

  const exportToJson = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(extractedResults, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "e_geret_extraction.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Toast Notification */}
      {showSavedToast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-emerald-600 text-white px-6 py-2 rounded-full shadow-2xl z-[200] text-sm font-bold flex items-center gap-2 animate-bounce">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7"></path></svg>
          Changes Persisted to Library
        </div>
      )}

      {/* Navbar */}
      <nav className="bg-white border-b border-slate-200 sticky top-0 z-[100] h-16 shrink-0">
        <div className="max-w-[1800px] mx-auto h-full px-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-slate-900 rounded-2xl flex items-center justify-center text-white shadow-xl rotate-3">
              <span className="font-black text-xl">E</span>
            </div>
            <div>
              <h1 className="font-black text-xl tracking-tight text-slate-800 uppercase">E-Geret</h1>
              <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest leading-none">Metadata Parser</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <input 
              type="file" 
              id="file-upload-input"
              multiple 
              accept=".html,.htm" 
              className="hidden" 
              ref={fileInputRef} 
              onChange={handleFileUpload} 
            />
            <Button variant="secondary" onClick={triggerUpload} className="h-10 rounded-xl font-bold text-xs uppercase tracking-wider px-6 border-slate-300">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
              Upload Sources
            </Button>
            {extractedResults.length > 0 && (
              <Button onClick={exportToJson} variant="primary" className="h-10 rounded-xl font-bold text-xs uppercase tracking-wider px-6 bg-slate-900 hover:bg-black shadow-lg shadow-slate-200">
                Export JSON
              </Button>
            )}
          </div>
        </div>
      </nav>

      <main className="flex-1 max-w-[1800px] mx-auto w-full p-6 grid grid-cols-1 lg:grid-cols-12 gap-8 overflow-hidden">
        
        {/* Configuration Sidebar */}
        <aside className="lg:col-span-4 space-y-6 overflow-y-auto max-h-[calc(100vh-120px)] scrollbar-hide pr-2">
          
          {/* Template Library */}
          <Card className="border-none shadow-sm ring-1 ring-slate-200">
            <CardHeader title="Saved Templates" subtitle="Select stored extraction rules" />
            <CardContent className="p-0">
              {savedTemplates.length === 0 ? (
                <div className="p-10 text-center">
                  <div className="w-12 h-12 bg-slate-50 rounded-xl mx-auto flex items-center justify-center mb-4">
                    <svg className="w-6 h-6 text-slate-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
                  </div>
                  <p className="text-xs text-slate-400 font-medium">Library is empty. Define rules below and save.</p>
                </div>
              ) : (
                <div className="max-h-60 overflow-y-auto divide-y divide-slate-100">
                  {savedTemplates.map(tpl => (
                    <div 
                      key={tpl.id} 
                      onClick={() => loadTemplate(tpl)}
                      className={`px-6 py-4 flex items-center justify-between cursor-pointer transition-all group ${activeTemplateId === tpl.id ? 'bg-indigo-50 border-l-4 border-indigo-600' : 'hover:bg-slate-50'}`}
                    >
                      <div className="flex flex-col">
                        <span className={`text-sm font-black ${activeTemplateId === tpl.id ? 'text-indigo-700' : 'text-slate-700'}`}>{tpl.name}</span>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">{tpl.fields.length} Fields</span>
                          <span className="text-[10px] text-slate-300">•</span>
                          <span className="text-[10px] text-slate-400 font-mono">{tpl.containerSelector || 'No Root'}</span>
                        </div>
                      </div>
                      <button onClick={(e) => deleteTemplate(tpl.id, e)} className="p-2 text-slate-200 hover:text-red-500 hover:bg-white rounded-lg transition-all opacity-0 group-hover:opacity-100">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Core Configuration */}
          <Card className="border-none shadow-sm ring-1 ring-slate-200">
            <CardHeader 
              title="Extraction Rules" 
              subtitle="Define how letters and footnotes are mapped"
              action={
                <Button variant="ghost" size="sm" onClick={handleSuggestTemplate} isLoading={status === AppStatus.GENERATING_TEMPLATE} className="text-[10px] font-black text-indigo-600">
                  AUTO-DETECT
                </Button>
              }
            />
            <CardContent className="space-y-4">
              <div className="p-4 bg-slate-900 rounded-2xl shadow-xl shadow-slate-200 space-y-2">
                <label className="text-[10px] font-black text-indigo-400 uppercase tracking-widest block">Unit Container (CSS Selector)</label>
                <input 
                  className="w-full bg-transparent border-none focus:ring-0 text-xs font-mono text-white p-0 placeholder:text-slate-700"
                  placeholder="e.g. div.correspondence-block"
                  value={containerSelector}
                  onChange={(e) => setContainerSelector(e.target.value)}
                />
              </div>

              <div className="space-y-3">
                {fields.length === 0 ? (
                  <div className="py-10 border-2 border-dashed border-slate-100 rounded-2xl text-center">
                    <p className="text-xs text-slate-400">No fields defined. Use Auto-Detect or Add Manual.</p>
                  </div>
                ) : (
                  fields.map((field) => (
                    <div key={field.id} className="p-4 border border-slate-100 rounded-2xl bg-white shadow-sm group relative hover:ring-2 hover:ring-indigo-100 transition-all">
                      <button 
                        onClick={() => setFields(fields.filter(f => f.id !== field.id))} 
                        className="absolute top-2 right-2 p-1.5 text-slate-200 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                      </button>
                      <input 
                        className="w-full bg-transparent border-none focus:ring-0 font-black text-slate-800 p-0 text-sm placeholder:text-slate-300 uppercase mb-2 tracking-tight"
                        value={field.name}
                        onChange={(e) => setFields(fields.map(f => f.id === field.id ? {...f, name: e.target.value} : f))}
                        placeholder="Field Name"
                      />
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 bg-slate-50 px-2 py-1.5 rounded-lg border border-slate-100">
                          <span className="text-[8px] font-black text-slate-400 uppercase">CSS/Rule</span>
                          <input 
                            className="flex-1 bg-transparent border-none focus:ring-0 text-[10px] font-mono text-indigo-600 p-0" 
                            value={field.selector} 
                            onChange={(e) => setFields(fields.map(f => f.id === field.id ? {...f, selector: e.target.value} : f))}
                            placeholder=".class or logic"
                          />
                        </div>
                        <input 
                          className="w-full text-[10px] text-slate-500 border-none bg-transparent focus:ring-0 p-0 italic" 
                          value={field.description} 
                          placeholder="Extraction logic hint..." 
                          onChange={(e) => setFields(fields.map(f => f.id === field.id ? {...f, description: e.target.value} : f))} 
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <Button variant="secondary" className="h-12 rounded-2xl text-[10px] font-black uppercase tracking-widest border-slate-200" onClick={handleAddField}>
                  Add Field
                </Button>
                {activeTemplateId ? (
                  <Button variant="secondary" className="h-12 rounded-2xl text-[10px] font-black uppercase tracking-widest text-indigo-600 border-indigo-200 bg-indigo-50/30" onClick={updateExistingTemplate}>
                    Update Library
                  </Button>
                ) : (
                  <Button variant="secondary" className="h-12 rounded-2xl text-[10px] font-black uppercase tracking-widest text-indigo-600 border-indigo-200" onClick={saveNewTemplate}>
                    Save to Library
                  </Button>
                )}
                <Button 
                  variant="primary" 
                  className="col-span-2 h-14 rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-[10px] font-black uppercase tracking-widest shadow-xl shadow-indigo-100"
                  disabled={files.length === 0 || fields.length === 0}
                  isLoading={status === AppStatus.EXTRACTING}
                  onClick={runExtraction}
                >
                  Split & Correlate Letters
                </Button>
              </div>
            </CardContent>
          </Card>
        </aside>

        {/* Results Main Area */}
        <section className="lg:col-span-8 flex flex-col min-h-0">
          <Card className="flex-1 flex flex-col border-none shadow-2xl shadow-slate-200/50 rounded-[2.5rem] overflow-hidden">
            <CardHeader 
              title="Document Inspector" 
              subtitle={extractedResults.length > 0 ? `${extractedResults.length} letters resolved with footnotes` : "Data grid will populate after extraction"}
            />
            <CardContent className="p-0 flex-1 overflow-hidden relative bg-white">
              {extractedResults.length === 0 ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-300 p-12 text-center">
                  {status === AppStatus.EXTRACTING ? (
                    <div className="space-y-8 flex flex-col items-center">
                      <div className="relative">
                        <div className="w-24 h-24 border-8 border-slate-50 border-t-indigo-600 rounded-full animate-spin"></div>
                        <div className="absolute inset-0 flex items-center justify-center text-lg font-black text-indigo-600">
                          {Math.round((progress.current / progress.total) * 100)}%
                        </div>
                      </div>
                      <div className="space-y-1">
                        <p className="text-lg font-black text-slate-800 tracking-tight">ANALYZING DOCUMENT</p>
                        <p className="text-xs text-slate-500 max-w-xs leading-relaxed font-medium">Gemini is mapping footnote pointers to definition blocks...</p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-6">
                      <div className="w-24 h-24 bg-slate-50 rounded-full flex items-center justify-center shadow-inner">
                        <svg className="w-12 h-12 opacity-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
                      </div>
                      <div className="space-y-2">
                        <p className="text-sm font-black text-slate-400 uppercase tracking-[0.2em]">Metadata Lab Active</p>
                        <p className="text-xs text-slate-300">Upload correspondence to begin</p>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="overflow-auto h-full scrollbar-thin scrollbar-thumb-slate-200">
                  <table className="w-full text-left border-collapse min-w-max">
                    <thead className="sticky top-0 z-30">
                      <tr className="bg-slate-50/95 backdrop-blur-md border-b border-slate-100">
                        <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Source Context</th>
                        {fields.map(field => (
                          <th key={field.id} className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">{field.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {extractedResults.map((result) => (
                        <tr key={result.id} className="hover:bg-slate-50/80 transition-all duration-300">
                          <td className="px-8 py-6 align-top">
                            <div className="flex flex-col gap-1">
                              <span className="text-[10px] font-black text-slate-800 truncate max-w-[150px] uppercase tracking-tighter">{result.fileName}</span>
                              <span className="text-[9px] font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full w-fit">Letter #{result.letterIndex}</span>
                            </div>
                          </td>
                          {fields.map(field => (
                            <td key={field.id} className="px-8 py-6 align-top text-xs text-slate-600 font-medium leading-relaxed max-w-sm">
                              <div className="max-h-60 overflow-y-auto pr-4 scrollbar-thin whitespace-pre-wrap">
                                {result.data[field.name] || <span className="text-slate-200 italic">Unmatched</span>}
                              </div>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </section>

      </main>

      {/* Upload Info Badge */}
      {files.length > 0 && status === AppStatus.IDLE && (
        <div className="fixed bottom-6 right-6 bg-slate-900 text-white px-6 py-4 rounded-3xl shadow-2xl flex items-center gap-6 z-[200] border border-slate-700 animate-in slide-in-from-right duration-300">
          <div className="flex flex-col">
            <span className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Current Batch</span>
            <span className="text-xs font-bold">{files.length} HTML Sources Loaded</span>
          </div>
          <div className="w-px h-8 bg-slate-700"></div>
          <button onClick={() => { setFiles([]); setExtractedResults([]); }} className="text-xs font-black text-red-400 hover:text-red-300 uppercase tracking-widest transition-colors">
            Clear
          </button>
        </div>
      )}
    </div>
  );
};

export default App;
