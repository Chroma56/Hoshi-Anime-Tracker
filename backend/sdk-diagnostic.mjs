
 // Hoshi SDK Diagnostic V1
 // Checks anime-sdk without requesting or playing video.
 // Does not modify environment settings.

async function main() {
  console.log('================================');
  console.log('HOSHI SDK DIAGNOSTIC V1');
  console.log('================================');

  try {
    const sdk = await import('anime-sdk');

    console.log('SDK import: SUCCESS');

    const required = [
      'HttpClient',
      'AnilistMeta',
      'MegaPlayProvider'
    ];

    let missing = false;

    for (const name of required) {
      const available =
        typeof sdk[name] === 'function';

      console.log(
        name + ': ' +
        (available ? 'AVAILABLE' : 'MISSING')
      );

      if (!available) {
        missing = true;
      }
    }

    if (missing) {
      throw new Error(
        'One or more required SDK exports are missing'
      );
    }

    const http = new sdk.HttpClient({
      timeoutMs: 4000
    });

    const meta = new sdk.AnilistMeta(http);
    const provider = new sdk.MegaPlayProvider(http);

    console.log(
      'HTTP client: INITIALISED'
    );

    console.log(
      'AniList metadata: ' +
      (
        typeof meta.resolveStream === 'function'
          ? 'READY'
          : 'MISSING resolveStream'
      )
    );

    console.log(
      'MegaPlay provider: ' +
      (
        typeof provider.resolveStream === 'function'
          ? 'READY'
          : 'MISSING resolveStream'
      )
    );

    if (
      typeof meta.resolveStream !== 'function' ||
      typeof provider.resolveStream !== 'function'
    ) {
      throw new Error(
        'SDK resolver methods are unavailable'
      );
    }

    console.log('--------------------------------');
    console.log('HOSHI SDK DIAGNOSTIC: PASSED');
    console.log('No episode or video requests made.');
    console.log('--------------------------------');

  } catch (error) {
    console.error(
      'HOSHI SDK DIAGNOSTIC: FAILED'
    );

    console.error(
      error && error.message
        ? error.message
        : String(error)
    );

    process.exitCode = 1;
  }
}

await main();
