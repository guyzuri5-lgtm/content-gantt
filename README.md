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
- **מסך ניתוח רילז** (לשונית "ניתוח רילז"): דירוג הרילז, מה להמשיך / להפסיק / לתקן, מילים שחוזרות בכיתובים המצליחים, וכפתור שמושך רילז חדשים מאינסטגרם
- מצב כהה ותצוגת agenda למובייל

- גיבוי לקובץ JSON ושחזור ממנו (מיזוג או החלפה מלאה)
- סנכרון בין מכשירים דרך Supabase — **בלי התחברות**: הלוח נפתח לכל מי שמגיע לכתובת

## שמירת נתונים ומי יכול לגשת
אין חשבונות ואין סיסמאות. **כל מי שפותח את הכתובת רואה ועורך את אותו לוח** — הוא נשמר בשורה אחת משותפת ב-Supabase (`shared_boards`, מזהה `main`), ונתוני הרילז לצידה (`shared_ig_imports`).

**מה זה אומר בפועל:** הכתובת ב-Vercel אינה סוד, ומפתח ה-`anon` יושב גלוי בקוד הדף. לכן כל מי שמגיע לכתובת — גם במקרה — יכול לקרוא את תוכנית התוכן ואת נתוני האינסטגרם, וגם לערוך ולמחוק אותם. ה-RLS של שתי הטבלאות פתוח בכוונה, וזו ההחלטה שהתקבלה במודע כדי להסיר את מסך ההתחברות. אם יום אחד צריך הגנה אמיתית, אין דרך לעשות את זה בלי להחזיר חשבונות.

הלוח לא נפתח לעריכה עד שהמשיכה הראשונה מהענן הסתיימה, כדי שלא תקלידו לתוך עותק ריק. אם המשיכה נכשלה הוא כן נפתח ועובד מקומית — המיזוג תוספתי ולא מוחק כלום.

ה-`localStorage` (מפתח `content-gantt-data-v1`) משמש כמטמון מקומי בלבד — המקור הוא הענן.

## הפעלת סנכרון ענן
1. פותחים פרויקט ב-[supabase.com](https://supabase.com) (שכבת חינם מספיקה).
2. ב-SQL Editor מריצים — **שתי הטבלאות לא תלויות ב-`auth.users`**, ולכן אפשר לכתוב אליהן בלי חשבון:

```sql
create table if not exists public.shared_boards (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.shared_ig_imports (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.shared_boards     enable row level security;
alter table public.shared_ig_imports enable row level security;

-- פתוח בכוונה: אין התחברות, וכל מי שמגיע לכתובת עובד על אותה שורה
create policy "open read"   on public.shared_boards for select using (true);
create policy "open insert" on public.shared_boards for insert with check (true);
create policy "open update" on public.shared_boards for update using (true) with check (true);

create policy "open read"   on public.shared_ig_imports for select using (true);
create policy "open insert" on public.shared_ig_imports for insert with check (true);
create policy "open update" on public.shared_ig_imports for update using (true) with check (true);
```

3. אם כבר היה מידע בטבלאות הישנות (`boards` / `ig_imports`), מעבירים אותו פעם אחת. ב-SQL Editor אין RLS, ולכן זה עובד גם בלי החשבון שאליו הן היו קשורות:

```sql
insert into public.shared_boards (id, data)
select 'main', data from public.boards order by updated_at desc limit 1
on conflict (id) do update set data = excluded.data, updated_at = now();

insert into public.shared_ig_imports (id, data)
select 'main', data from public.ig_imports order by updated_at desc limit 1
on conflict (id) do update set data = excluded.data, updated_at = now();
```

   אם אחת הטבלאות הישנות לא קיימת, מדלגים על השורות שלה. אחרי שמאמתים שהלוח נטען כמו שצריך אפשר למחוק אותן (`drop table public.boards, public.ig_imports;`).

4. ב-`index.html`, בראש בלוק ה-`<script>`, ממלאים את `SUPABASE_URL` ואת `SUPABASE_ANON_KEY` (המפתח הפומבי בלבד — לא `service_role`).

כל עוד שני הערכים ריקים, הלוח עובד עם שמירה מקומית בלבד.

עקרונות הסנכרון: שמירה מקומית תמיד קודמת (הלוח עובד גם בלי רשת), דחיפה לענן אף פעם לא קורית לפני משיכה ראשונה, והמיזוג תוספתי — פריט שקיים רק בצד אחד נשמר ולא נמחק. **שימו לב:** בלוח משותף שני אנשים שעורכים בו-זמנית ידרסו זה את זה, כי מה שנדחף אחרון מנצח.

## הרצה מקומית
פותחים את `index.html` בדפדפן. זהו.

## דיפלוי
מתארח ב-Vercel: `index.html` מוגש כאתר סטטי, ותיקיית `api/` נפרסת כפונקציית שרת אחת ללא תלויות חיצוניות (fetch בלבד). אין שלב build.

## מסך ניתוח הרילז
לשונית "ניתוח רילז" בראש הדף. כל המדדים מחושבים בדפדפן מהנתונים הגולמיים, ולכן כל שינוי פרמטר מצייר מחדש מיד ובלי פנייה לרשת.

**מה יש שם:** הריל הכי נצפה מול החציון · שישה מדדים מהירים · שלוש עמודות פעולה (להמשיך / להפסיק / לתקן) · מילים שחוזרות בכיתובים של המובילים ונעדרות מהנופלים · רשימה מלאה של כל ריל עם חשיפה, צפיות, זמן צפייה, מעורבות, שיתופים, שמירות וצפייה חוזרת.

**שלושת הצירים** (הוק / חשיפה / ויראליות) הם **דירוג יחסי** בין הרילז שלכם, 0–100: ציון 70 בציר החשיפה אומר שהריל נחשף יותר מ-70% מהרילז האחרים בחלון. בכוונה דירוג ולא מתיחה בין המינימום למקסימום — הצלחה חריגה אחת מועכת את כל השאר לאפס ומתייגת רילז סבירים כ"חלש בכל הצירים".

**הפרמטרים** (חלון ניתוח, סף הוק חזק, סף צפייה חוזרת, אורך הרשימות, מיון) נשמרים ב-state ומסתנכרנים בין מכשירים כמו כל הגדרה אחרת.

## כפתור "ניתוח רילז חדשים"
מושך מאינסטגרם את הרילז שעוד לא במערכת, ובנוסף מרענן את המספרים של הרילז מהימים האחרונים — צפיות וחשיפה ממשיכות לזוז אחרי הפרסום. "רענון מלא" מושך מחדש את כל החלון.

השליפה רצה בפונקציית שרת ([api/ig-refresh.mjs](api/ig-refresh.mjs)) ולא בדפדפן, כי היא דורשת מפתח API שאסור שיהיה בקוד הלקוח. היא כותבת לשורה המשותפת ב-`shared_ig_imports`.

מכיוון שאין התחברות, אין למי להזדהות — מה ששומר על הפונקציה הוא חיכוך בלבד: היא דוחה בקשות שלא הגיעו מהאתר עצמו, ולא רצה יותר מפעם בדקה. זו לא הגנה אמיתית (כותרת `Origin` קלה לזיוף, ומגבלת הקצב היא לכל מופע שרת בנפרד), אבל זה מספיק כדי שסורק אקראי או לולאת ניסיונות תקועה לא ישרפו את מכסת Composio.

**הפעלה חד־פעמית:**
1. ב-Vercel → Project Settings → Environment Variables מוסיפים `COMPOSIO_API_KEY` (מפתח ברמת פרויקט מ-[platform.composio.dev](https://platform.composio.dev)).
2. Deploy מחדש.
3. חיבור ראשוני לאינסטגרם הוא אישור OAuth ידני ולכן לא יכול לקרות בשרת: מריצים פעם אחת `cd ig-report && npm install && npm run agent` ופותחים את הקישור שיודפס. אחרי זה החיבור נשמר והכפתור עובד מכל מכשיר.

`SUPABASE_URL` ו-`SUPABASE_ANON_KEY` נופלים חזרה לערכים שהלוח ממילא מכיל, ולכן אין צורך להגדיר אותם. `ANTHROPIC_API_KEY` **כבר לא נחוץ** — השליפה דטרמיניסטית ולא מריצה מודל.

הכפתור עובד רק באתר המפורסם, לא בפתיחת `index.html` מהדיסק.

## `ig-report/` — הרצה מקומית של אותו צינור
תת-פרויקט שמייצר דוח HTML עצמאי (`report.html`). מאז האיחוד הוא **חולק את מנוע השליפה** עם הכפתור שבלוח — שניהם מייבאים את [api/_lib/instagram.mjs](api/_lib/instagram.mjs), כך שאין שתי מימושים שיכולים להיפרד.

התפקיד שנשאר לו בלעדית: החיבור הראשוני לאינסטגרם, שדורש אדם מול דפדפן.

הרצה: `cd ig-report && npm install && npm run report` (דורש `.env` עם `COMPOSIO_API_KEY`).
פירוט מלא ב-[ig-report/README.md](ig-report/README.md).

**לא נשמרים בריפו:** `.env`, `node_modules/`, `data.json`, `thumbs/`, `report.html`.
