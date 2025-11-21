// More internally rooted session that gets sent to the API
export interface LMArenaSession {
   id: string;
   messages: Array<LMArenaMessage>;
   modality: "text" | "image";
   mode: "direct";
   modelAId: string;

   // The message ID that the completion is saved to
   modelAMessageId: string;

   // The message ID that's used as the prompt for the completion
   userMessageId: string;
}

export interface Attachment {
   mime: string;
   content: Buffer;
   r2Key: string | null;
   r2BucketUrl: string | null;
}

export interface LargeAttachment {
   mime: string;
   size: number;
   filePath: string;
   r2Key: string | null;
   r2BucketUrl: string | null;
}

export interface ChatMessage {
   role: "user" | "assistant" | "system";
   content: string;
   attachments: Array<Attachment>;
   id: string;
}

// Abstract chat session that the codebase uses
export interface ChatSession {
   lmSession: LMArenaSession;

   // This is used as a flag to determine whether we need to call the create-evaluation API, or the post API to an existing session
   doesSessionExist: true;
   sessionId: string | null;
   messages: Array<ChatMessage>;
}
