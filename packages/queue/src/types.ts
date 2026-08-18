export interface QueueMessage<T> {
  id: string;
  receipt: string;
  body: T;
  attempts: number;
}

export interface Queue<T> {
  enqueue(message: T): Promise<void>;
  /** The signal applies to an idle receive only; consumers finish claimed work. */
  receive(maxMessages: number, signal?: AbortSignal): Promise<QueueMessage<T>[]>;
  acknowledge(receipt: string): Promise<void>;
}

export interface QueueConsumer<T> {
  handle(message: T, signal?: AbortSignal): Promise<void>;
}
