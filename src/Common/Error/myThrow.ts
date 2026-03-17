
export const toError = {
    set convert(e: any){
        if (e instanceof Error) {throw e}
        throw new Error(JSON.stringify(e))
    },
    throw(e: any){
        if (e instanceof Error) {throw e}
        throw new Error(JSON.stringify(e))
    },
    convertToMsg(e: any){
        if (e instanceof Error) {return e}
        return e
    }
}