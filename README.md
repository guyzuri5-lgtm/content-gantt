# גאנט תוכן

לוח תכנון תוכן חודשי (עברית, RTL) — אפליקציית עמוד יחיד ללא תלויות ובלי שלב build.
כל הקוד יושב ב-`index.html`.

## מה יש בפנים
- לוח שנה חודשי; לחיצה על יום מוסיפה פריט תוכן
- סיווג לפי סוג תוכן (ניתן להתאמה) ולפי פוסט/סטורי
- שדות הערות (עד 4000 תווים) וכיתוב/caption (עד 2200 תווים) לכל פריט
- סטטוסי התקדמות הניתנים לעריכה מהממשק: שם, צבע, סדר, הוספה ומחיקה (ברירת מחדל: צולם / נערך / תוזמן)
- בחירה מהממשק ממה יושפע צבע המלבן של פיסת התוכן וממה יושפע העיגול שבתוכו — מסוג התוכן או מהסטטוס
- העברת פריטים ליום אחר בגרירה או דרך בורר תאריך
- ייבוא מ-Instagram: Reels שכבר פורסמו מוטמעים כפריטים לקריאה בלבד עם נתוני ביצועים
- מצב כהה ותצוגת agenda למובייל

- גיבוי לקובץ JSON ושחזור ממנו (מיזוג או החלפה מלאה)
- סנכרון אופציונלי בין מכשירים דרך Supabase, עם התחברות בקישור למייל

## שמירת נתונים
הנתונים נשמרים ב-`localStorage` בדפדפן (מפתח `content-gantt-data-v1`), לכל דומיין בנפרד.
**ניקוי נתוני גלישה מוחק אותם ואין שחזור** — לכן כדאי להוריד גיבוי מדי פעם, או להפעיל סנכרון ענן.

## הפעלת סנכרון ענן (אופציונלי)
1. פותחים פרויקט ב-[supabase.com](https://supabase.com) (שכבת חינם מספיקה).
2. ב-SQL Editor מריצים:

```sql
create table if not exists public.boards (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.boards enable row level security;

create policy "read own board"   on public.boards for select using (auth.uid() = user_id);
create policy "insert own board" on public.boards for insert with check (auth.uid() = user_id);
create policy "update own board" on public.boards for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

3. ב-Authentication → URL Configuration מגדירים את כתובת האתר תחת Site URL ותחת Redirect URLs.
4. ב-`index.html`, בראש בלוק ה-`<script>`, ממלאים את `SUPABASE_URL` ואת `SUPABASE_ANON_KEY` (המפתח הפומבי בלבד — לא `service_role`).

כל עוד שני הערכים ריקים, הלוח עובד בדיוק כמו קודם עם שמירה מקומית בלבד.

עקרונות הסנכרון: שמירה מקומית תמיד קודמת (הלוח עובד גם בלי רשת), דחיפה לענן אף פעם לא קורית לפני משיכה ראשונה, והמיזוג בין מכשירים תוספתי — פריט שקיים רק בצד אחד נשמר ולא נמחק.

## הרצה מקומית
פותחים את `index.html` בדפדפן. זהו.

## דיפלוי
מתארח ב-Vercel כאתר סטטי.
