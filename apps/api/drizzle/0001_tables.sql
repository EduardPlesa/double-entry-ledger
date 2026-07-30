CREATE TYPE "public"."account_type" AS ENUM('asset', 'liability', 'equity', 'revenue', 'expense');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"book_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"currency" text NOT NULL,
	"parent_id" uuid,
	"closed_at" timestamp with time zone,
	CONSTRAINT "accounts_id_book_id_key" UNIQUE("id","book_id"),
	CONSTRAINT "accounts_id_book_id_currency_key" UNIQUE("id","book_id","currency"),
	CONSTRAINT "accounts_name_not_blank" CHECK (length(btrim("accounts"."name")) > 0),
	CONSTRAINT "accounts_currency_iso4217" CHECK ("accounts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "accounts_parent_not_self" CHECK ("accounts"."parent_id" is distinct from "accounts"."id")
);
--> statement-breakpoint
CREATE TABLE "books" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"base_currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "books_name_not_blank" CHECK (length(btrim("books"."name")) > 0),
	CONSTRAINT "books_base_currency_iso4217" CHECK ("books"."base_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"book_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text NOT NULL,
	"external_id" text,
	"reversal_of" uuid,
	"created_by_user_id" uuid,
	"created_by_api_key_id" uuid,
	CONSTRAINT "entries_id_book_id_key" UNIQUE("id","book_id"),
	CONSTRAINT "entries_description_not_blank" CHECK (length(btrim("entries"."description")) > 0),
	CONSTRAINT "entries_external_id_not_blank" CHECK ("entries"."external_id" is null or length(btrim("entries"."external_id")) > 0),
	CONSTRAINT "entries_reversal_not_self" CHECK ("entries"."reversal_of" is distinct from "entries"."id")
);
--> statement-breakpoint
CREATE TABLE "postings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entry_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	CONSTRAINT "postings_currency_iso4217" CHECK ("postings"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "postings_amount_nonzero" CHECK ("postings"."amount_minor" <> 0)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_same_book_fk" FOREIGN KEY ("parent_id","book_id") REFERENCES "public"."accounts"("id","book_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_reversal_same_book_fk" FOREIGN KEY ("reversal_of","book_id") REFERENCES "public"."entries"("id","book_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postings" ADD CONSTRAINT "postings_entry_same_book_fk" FOREIGN KEY ("entry_id","book_id") REFERENCES "public"."entries"("id","book_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postings" ADD CONSTRAINT "postings_account_same_book_currency_fk" FOREIGN KEY ("account_id","book_id","currency") REFERENCES "public"."accounts"("id","book_id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entries_book_id_external_id_key" ON "entries" USING btree ("book_id","external_id") WHERE "entries"."external_id" is not null;