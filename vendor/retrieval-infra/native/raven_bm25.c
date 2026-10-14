/*
** bm25_cached(): the FTS5 bm25() ranking function of SQLite 3.51.3 (ext/fts5/fts5_aux.c,
** fts5Bm25GetData and fts5Bm25Function), with one change: the number of rows that contain
** each query phrase is remembered for the life of the connection.
**
** The built-in bm25() recounts those rows for every statement by walking the phrase's whole
** posting list, which for words such as "2026" means millions of entries per query. A frozen
** index never changes, so the count for a given phrase is a constant and every score is
** computed from exactly the same numbers in the same order as bm25(). Use it only on
** read-only, never-modified FTS5 tables; queries must not use column filters or prefixes,
** which the cache key (the phrase's tokens) does not record.
**
** Build: cc -O2 -fPIC -shared -I<dir with sqlite3.h, sqlite3ext.h> raven_bm25.c -o raven_bm25.so -lm
*/
#include "sqlite3ext.h"
SQLITE_EXTENSION_INIT1
#include <math.h>
#include <string.h>

typedef struct CountEntry CountEntry;
struct CountEntry {
  CountEntry *pNext;
  sqlite3_int64 nHit;
  int nKey;
  char aKey[1];
};

typedef struct CountCache {
  CountEntry **aSlot;
  int nSlot;
  int nEntry;
  sqlite3_int64 nLookup;
  sqlite3_int64 nMiss;
} CountCache;

static unsigned int keyHash(const char *z, int n){
  unsigned int h = 2166136261u;
  int i;
  for(i=0; i<n; i++){ h ^= (unsigned char)z[i]; h *= 16777619u; }
  return h;
}

static CountEntry *cacheFind(CountCache *p, const char *zKey, int nKey){
  CountEntry *e;
  if( p->nSlot==0 ) return 0;
  for(e=p->aSlot[keyHash(zKey, nKey) % p->nSlot]; e; e=e->pNext){
    if( e->nKey==nKey && memcmp(e->aKey, zKey, nKey)==0 ) return e;
  }
  return 0;
}

static int cacheInsert(CountCache *p, const char *zKey, int nKey, sqlite3_int64 nHit){
  CountEntry *e;
  unsigned int h;
  if( p->nEntry >= p->nSlot ){
    int nNew = p->nSlot ? p->nSlot*2 : 1024;
    CountEntry **aNew = (CountEntry**)sqlite3_malloc64(sizeof(CountEntry*)*(sqlite3_int64)nNew);
    int i;
    if( aNew==0 ) return SQLITE_NOMEM;
    memset(aNew, 0, sizeof(CountEntry*)*(size_t)nNew);
    for(i=0; i<p->nSlot; i++){
      CountEntry *pNext;
      for(e=p->aSlot[i]; e; e=pNext){
        unsigned int hh = keyHash(e->aKey, e->nKey) % nNew;
        pNext = e->pNext;
        e->pNext = aNew[hh];
        aNew[hh] = e;
      }
    }
    sqlite3_free(p->aSlot);
    p->aSlot = aNew;
    p->nSlot = nNew;
  }
  e = (CountEntry*)sqlite3_malloc64(sizeof(CountEntry) + nKey);
  if( e==0 ) return SQLITE_NOMEM;
  e->nHit = nHit;
  e->nKey = nKey;
  memcpy(e->aKey, zKey, nKey);
  h = keyHash(zKey, nKey) % p->nSlot;
  e->pNext = p->aSlot[h];
  p->aSlot[h] = e;
  p->nEntry++;
  return SQLITE_OK;
}

static void cacheDestroy(void *pArg){
  CountCache *p = (CountCache*)pArg;
  int i;
  for(i=0; i<p->nSlot; i++){
    CountEntry *e, *pNext;
    for(e=p->aSlot[i]; e; e=pNext){ pNext = e->pNext; sqlite3_free(e); }
  }
  sqlite3_free(p->aSlot);
  sqlite3_free(p);
}

/* The phrase's tokens as the cache key: each token's length (4 bytes) and bytes. */
static int phraseKey(const Fts5ExtensionApi *pApi, Fts5Context *pFts, int iPhrase,
                     char **pzKey, int *pnKey){
  int nTok = pApi->xPhraseSize(pFts, iPhrase);
  int i, rc = SQLITE_OK, n = 0, nAlloc = 64;
  char *z = (char*)sqlite3_malloc(nAlloc);
  if( z==0 ) return SQLITE_NOMEM;
  for(i=0; rc==SQLITE_OK && i<nTok; i++){
    const char *zTok = 0;
    int nTokByte = 0;
    rc = pApi->xQueryToken(pFts, iPhrase, i, &zTok, &nTokByte);
    if( rc==SQLITE_OK ){
      if( n + 4 + nTokByte > nAlloc ){
        char *zNew;
        nAlloc = (n + 4 + nTokByte) * 2;
        zNew = (char*)sqlite3_realloc(z, nAlloc);
        if( zNew==0 ){ rc = SQLITE_NOMEM; break; }
        z = zNew;
      }
      memcpy(&z[n], &nTokByte, 4);
      memcpy(&z[n+4], zTok, nTokByte);
      n += 4 + nTokByte;
    }
  }
  if( rc!=SQLITE_OK ){ sqlite3_free(z); return rc; }
  *pzKey = z;
  *pnKey = n;
  return SQLITE_OK;
}

typedef struct Fts5Bm25Data Fts5Bm25Data;
struct Fts5Bm25Data {
  int nPhrase;                    /* Number of phrases in query */
  double avgdl;                   /* Average number of tokens in each row */
  double *aIDF;                   /* IDF for each phrase */
  double *aFreq;                  /* Array used to calculate phrase freq. */
};

static int fts5CountCb(const Fts5ExtensionApi *pApi, Fts5Context *pFts, void *pUserData){
  sqlite3_int64 *pn = (sqlite3_int64*)pUserData;
  (void)pApi; (void)pFts;
  (*pn)++;
  return SQLITE_OK;
}

static int fts5Bm25GetData(const Fts5ExtensionApi *pApi, Fts5Context *pFts,
                           CountCache *pCache, Fts5Bm25Data **ppData){
  int rc = SQLITE_OK;
  Fts5Bm25Data *p;

  p = (Fts5Bm25Data*)pApi->xGetAuxdata(pFts, 0);
  if( p==0 ){
    int nPhrase;
    sqlite3_int64 nRow = 0;
    sqlite3_int64 nToken = 0;
    sqlite3_int64 nByte;
    int i;

    nPhrase = pApi->xPhraseCount(pFts);
    nByte = sizeof(Fts5Bm25Data) + nPhrase*2*sizeof(double);
    p = (Fts5Bm25Data*)sqlite3_malloc64(nByte);
    if( p==0 ){
      rc = SQLITE_NOMEM;
    }else{
      memset(p, 0, (size_t)nByte);
      p->nPhrase = nPhrase;
      p->aIDF = (double*)&p[1];
      p->aFreq = &p->aIDF[nPhrase];
    }

    if( rc==SQLITE_OK ) rc = pApi->xRowCount(pFts, &nRow);
    if( rc==SQLITE_OK ) rc = pApi->xColumnTotalSize(pFts, -1, &nToken);
    if( rc==SQLITE_OK ) p->avgdl = (double)nToken  / (double)nRow;

    for(i=0; rc==SQLITE_OK && i<nPhrase; i++){
      sqlite3_int64 nHit = 0;
      char *zKey = 0;
      int nKey = 0;
      CountEntry *e;
      if( pApi->iVersion<3 ){
        /* No xQueryToken to name the phrase: count it like bm25() does, without caching. */
        rc = pApi->xQueryPhrase(pFts, i, (void*)&nHit, fts5CountCb);
        if( rc==SQLITE_OK ){
          double idf = log( (nRow - nHit + 0.5) / (nHit + 0.5) );
          if( idf<=0.0 ) idf = 1e-6;
          p->aIDF[i] = idf;
        }
        continue;
      }
      rc = phraseKey(pApi, pFts, i, &zKey, &nKey);
      if( rc!=SQLITE_OK ) break;
      pCache->nLookup++;
      e = cacheFind(pCache, zKey, nKey);
      if( e ){
        nHit = e->nHit;
      }else{
        pCache->nMiss++;
        rc = pApi->xQueryPhrase(pFts, i, (void*)&nHit, fts5CountCb);
        if( rc==SQLITE_OK ) rc = cacheInsert(pCache, zKey, nKey, nHit);
      }
      sqlite3_free(zKey);
      if( rc==SQLITE_OK ){
        double idf = log( (nRow - nHit + 0.5) / (nHit + 0.5) );
        if( idf<=0.0 ) idf = 1e-6;
        p->aIDF[i] = idf;
      }
    }

    if( rc!=SQLITE_OK ){
      sqlite3_free(p);
    }else{
      rc = pApi->xSetAuxdata(pFts, p, sqlite3_free);
    }
    if( rc!=SQLITE_OK ) p = 0;
  }
  *ppData = p;
  return rc;
}

static void fts5Bm25CachedFunction(const Fts5ExtensionApi *pApi, Fts5Context *pFts,
                                   sqlite3_context *pCtx, int nVal, sqlite3_value **apVal){
  const double k1 = 1.2;
  const double b = 0.75;
  int rc;
  double score = 0.0;
  Fts5Bm25Data *pData;
  int i;
  int nInst = 0;
  double D = 0.0;
  double *aFreq = 0;
  CountCache *pCache = (CountCache*)pApi->xUserData(pFts);

  rc = fts5Bm25GetData(pApi, pFts, pCache, &pData);
  if( rc==SQLITE_OK ){
    aFreq = pData->aFreq;
    memset(aFreq, 0, sizeof(double) * pData->nPhrase);
    rc = pApi->xInstCount(pFts, &nInst);
  }
  for(i=0; rc==SQLITE_OK && i<nInst; i++){
    int ip; int ic; int io;
    rc = pApi->xInst(pFts, i, &ip, &ic, &io);
    if( rc==SQLITE_OK ){
      double w = (nVal > ic) ? sqlite3_value_double(apVal[ic]) : 1.0;
      aFreq[ip] += w;
    }
  }

  if( rc==SQLITE_OK ){
    int nTok;
    rc = pApi->xColumnSize(pFts, -1, &nTok);
    D = (double)nTok;
  }

  if( rc==SQLITE_OK ){
    for(i=0; i<pData->nPhrase; i++){
      score += pData->aIDF[i] * (
          ( aFreq[i] * (k1 + 1.0) ) /
          ( aFreq[i] + k1 * (1 - b + b * D / pData->avgdl) )
      );
    }
    sqlite3_result_double(pCtx, -1.0 * score);
  }else{
    sqlite3_result_error_code(pCtx, rc);
  }
}

/* raven_bm25_cache(): "lookups misses entries" for the connection's phrase-count cache. */
static void cacheStatsFunction(sqlite3_context *pCtx, int nVal, sqlite3_value **apVal){
  CountCache *p = (CountCache*)sqlite3_user_data(pCtx);
  char *z = sqlite3_mprintf("%lld %lld %d", p->nLookup, p->nMiss, p->nEntry);
  (void)nVal; (void)apVal;
  sqlite3_result_text(pCtx, z, -1, sqlite3_free);
}

static fts5_api *fts5ApiFromDb(sqlite3 *db){
  fts5_api *pRet = 0;
  sqlite3_stmt *pStmt = 0;
  if( SQLITE_OK==sqlite3_prepare(db, "SELECT fts5(?1)", -1, &pStmt, 0) ){
    sqlite3_bind_pointer(pStmt, 1, (void*)&pRet, "fts5_api_ptr", 0);
    sqlite3_step(pStmt);
  }
  sqlite3_finalize(pStmt);
  return pRet;
}

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_extension_init(sqlite3 *db, char **pzErrMsg, const sqlite3_api_routines *pApi){
  fts5_api *pFts5;
  CountCache *pCache;
  int rc;
  SQLITE_EXTENSION_INIT2(pApi);
  pFts5 = fts5ApiFromDb(db);
  if( pFts5==0 || pFts5->iVersion<2 ){
    *pzErrMsg = sqlite3_mprintf("bm25_cached needs FTS5 API version 2 or later");
    return SQLITE_ERROR;
  }
  pCache = (CountCache*)sqlite3_malloc(sizeof(CountCache));
  if( pCache==0 ) return SQLITE_NOMEM;
  memset(pCache, 0, sizeof(CountCache));
  rc = sqlite3_create_function(db, "raven_bm25_cache", 0, SQLITE_UTF8, pCache, cacheStatsFunction, 0, 0);
  if( rc==SQLITE_OK ) rc = pFts5->xCreateFunction(pFts5, "bm25_cached", pCache, fts5Bm25CachedFunction, cacheDestroy);
  else cacheDestroy(pCache);
  return rc;
}
